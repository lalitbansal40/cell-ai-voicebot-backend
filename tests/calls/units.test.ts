import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  CALLS_PURGE_JOB,
  CALLS_REAPER_JOB,
  processMaintenanceJob,
  TTS_CACHE_PURGE_JOB,
} from '../../src/core/queues/workers/maintenance.worker';
import { LatencyMeter } from '../../src/core/voice/latency';
import { CallEventModel } from '../../src/db/models/call-event.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { FlowRunModel } from '../../src/db/models/flow-run.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { TtsCacheModel } from '../../src/db/models/tts-cache.model';
import { CallBilling, chargeCallUsage } from '../../src/modules/calls/billing';
import { canMove, endReasonFor, finalStatus, isFinal } from '../../src/modules/calls/lifecycle';
import { purgeCalls, reapCalls } from '../../src/modules/calls/maintenance';
import { CallRecorder, uploadRecording } from '../../src/modules/calls/recording';
import { CallRegistry } from '../../src/modules/calls/registry';
import { noScripts } from '../../src/modules/calls/scripts';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard, fund } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

useTestDb();
const storage = useTempStorage();
const dir = mkdtempSync(path.join(tmpdir(), 'cav-units-'));
const prefix = `${uniquePrefix('callunits')}:`;
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
let redis: Redis;
let registry: CallRegistry;

beforeAll(async () => {
  redis = (await requireRedis()).client;
  registry = new CallRegistry(redis, prefix);
  await ensureRateCard();
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('call lifecycle rules', () => {
  it('allows only forward moves; final statuses stay final', () => {
    expect(canMove('queued', 'ringing')).toBe(true);
    expect(canMove('ringing', 'in_progress')).toBe(true);
    expect(canMove('in_progress', 'queued')).toBe(false);
    expect(canMove('completed', 'failed')).toBe(false);
    expect(isFinal('canceled')).toBe(true);
    expect(isFinal('ringing')).toBe(false);
    // phone legs (dry run, SIP): busy / no answer only before the answer
    for (const to of ['busy', 'no_answer'] as const) {
      expect(canMove('ringing', to)).toBe(true);
      expect(canMove('queued', to)).toBe(false);
      expect(canMove('in_progress', to)).toBe(false);
      expect(isFinal(to)).toBe(true);
    }
  });

  it('maps end reasons and hang-up causes', () => {
    expect(finalStatus('hangup_node', true)).toBe('completed');
    expect(finalStatus('wallet_empty', true)).toBe('completed');
    expect(finalStatus('engine_error', true)).toBe('failed');
    expect(finalStatus('server_shutdown', true)).toBe('failed');
    expect(finalStatus('customer_hangup', false)).toBe('canceled');
    expect(finalStatus('canceled', false)).toBe('canceled');
    expect(finalStatus('media_timeout', false)).toBe('failed');
    expect(endReasonFor(undefined)).toBe('customer_hangup');
    expect(endReasonFor('normal')).toBe('customer_hangup');
    expect(endReasonFor('server_shutdown')).toBe('server_shutdown');
    expect(endReasonFor('limit')).toBe('limit');
    expect(finalStatus('busy', false)).toBe('busy');
    expect(finalStatus('no_answer', false)).toBe('no_answer');
    expect(finalStatus('invalid_number', false)).toBe('failed');
    expect(finalStatus('campaign_canceled', false)).toBe('canceled');
    expect(finalStatus('campaign_canceled', true)).toBe('completed');
    expect(endReasonFor('busy')).toBe('busy');
    expect(endReasonFor('no_answer')).toBe('no_answer');
    expect(endReasonFor('rejected')).toBe('busy');
    expect(endReasonFor('invalid_number')).toBe('invalid_number');
  });
});

describe('LatencyMeter', () => {
  it('measures customer-done → first bot frame and summarises percentiles', () => {
    const m = new LatencyMeter();
    expect(m.summary()).toEqual({ p50Ms: null, p95Ms: null, maxMs: null, samples: 0 });
    expect(m.botAudio(5)).toBeNull();
    for (const [done, bot] of [
      [0, 800],
      [1000, 2200],
      [3000, 3900],
      [5000, 5050],
    ]) {
      m.customerDone(done as number);
      expect(m.botAudio(bot as number)).toBe((bot as number) - (done as number));
      expect(m.botAudio((bot as number) + 20)).toBeNull();
    }
    m.customerDone(10);
    m.botAudio(5);
    expect(m.summary()).toEqual({ p50Ms: 800, p95Ms: 1200, maxMs: 1200, samples: 5 });
    const capped = new LatencyMeter();
    for (let i = 0; i < 250; i += 1) {
      capped.customerDone(0);
      capped.botAudio(i);
    }
    expect(capped.summary().samples).toBe(200);
  });
});

describe('CallRegistry', () => {
  it('registers, beats, lists live calls (dropping stale ones) and unregisters', async () => {
    await registry.register('c1', 'acct', 1000, 30);
    await registry.register('c2', 'acct', 1000, 1);
    await registry.heartbeat('c1', 'acct', 1000, 2000);
    expect(await registry.isLive('c1')).toBe(true);
    await redis.del(`${prefix}call:live:c2`);
    expect(await registry.liveCalls('acct')).toEqual(['c1']);
    expect(await redis.sismember(`${prefix}call:live:acct:acct`, 'c2')).toBe(0);
    await registry.unregister('c1', 'acct');
    expect(await registry.liveCalls('acct')).toEqual([]);
    expect(JSON.parse((await redis.get(`${prefix}call:live:c1`)) ?? 'null')).toBeNull();
  });
});

describe('CallBilling', () => {
  it('holds, extends, settles; no hold → nothing to extend or release; usage charges are idempotent', async () => {
    const accountId = new Types.ObjectId();
    await fund(accountId);
    const callId = new Types.ObjectId().toString();
    const b = new CallBilling(accountId.toString(), callId, false);
    expect(b.needsExtension(0)).toBe(false);
    expect(await b.extend()).toBe(false);
    await b.release('x');
    await expect(b.settle({ answered: true, durationSec: 1 })).rejects.toThrow('No hold to settle');
    await b.hold();
    expect(b.needsExtension(100)).toBe(false);
    expect(b.needsExtension(150)).toBe(true);
    expect(await b.extend()).toBe(true);
    expect(b.needsExtension(150)).toBe(false);
    const settled = await b.settle({
      answered: true,
      durationSec: 90,
      aiSeconds: 60,
      ttsChars: 100,
    });
    expect(settled.ledgerEntryId).not.toBeNull();
    expect(settled.cost.telephonyMicros).toBe(0);
    expect(settled.cost.totalMicros).toBeGreaterThan(0);
    const phone = new CallBilling(accountId.toString(), new Types.ObjectId().toString(), true);
    await phone.hold();
    expect(
      (await phone.settle({ answered: true, durationSec: 60 })).cost.telephonyMicros,
    ).toBeGreaterThan(0);
    const input = {
      accountId: accountId.toString(),
      callId,
      key: 'k1',
      amountMicros: 1000,
      model: 'm',
      inputTokens: 5,
      outputTokens: 2,
      embeddingTokens: 3,
    };
    await chargeCallUsage(input);
    expect((await chargeCallUsage(input)).replay).toBe(true);
    await chargeCallUsage({
      accountId: accountId.toString(),
      callId,
      key: 'k2',
      amountMicros: 1000,
      model: 'm',
    });
    const rows = await LedgerEntryModel.find({ 'ref.id': callId, type: 'ai_charge' }).lean();
    expect(rows.map((r) => r.breakdown?.kind)).toEqual(['call', 'call']);
  });
});

describe('recording', () => {
  it('writes stereo 8 kHz, uploads, removes the temp file; upload failures are retried then thrown', async () => {
    const rec = await CallRecorder.open(path.join(dir, 'nested'), 'r1', 24000);
    rec.customer(new Int16Array(480).fill(1000));
    rec.bot(new Int16Array(480).fill(2000));
    for (let i = 0; i < 50; i += 1) rec.tick();
    const closed = await rec.close();
    expect(closed.durationMs).toBe(1000);
    rec.customer(new Int16Array(480));
    rec.bot(new Int16Array(480));
    rec.tick();
    const accountId = new Types.ObjectId().toString();
    const saved = await uploadRecording(storage, {
      accountId,
      callId: 'r1',
      file: rec.file,
      durationMs: closed.durationMs,
    });
    expect(saved).toEqual({
      fileKey: `accounts/${accountId}/recordings/r1.wav`,
      durationSec: 1,
      sizeBytes: 44 + 32000,
      format: 'wav',
    });
    const file = path.join(dir, 'broken.wav');
    writeFileSync(file, 'x');
    const failing = { ...storage, put: vi.fn(() => Promise.reject(new Error('s3 down'))) };
    await expect(
      uploadRecording(failing as never, { accountId, callId: 'r2', file, durationMs: 0 }, 2),
    ).rejects.toThrow('s3 down');
    expect(failing.put).toHaveBeenCalledTimes(2);
    const flaky = {
      ...storage,
      put: vi
        .fn()
        .mockRejectedValueOnce(new Error('once'))
        .mockImplementation(storage.put.bind(storage)),
    };
    writeFileSync(file, 'y');
    expect(
      (await uploadRecording(flaky as never, { accountId, callId: 'r3', file, durationMs: 0 }))
        .sizeBytes,
    ).toBe(1);
  });

  it('no call scripts until the hosts are wired', async () => {
    await expect(noScripts({} as CallDoc)).rejects.toThrow('No call scripts');
  });
});

const makeCall = (over: Record<string, unknown>) =>
  CallModel.create({
    accountId: new Types.ObjectId(),
    direction: 'outbound',
    provider: 'webcall',
    from: 'webcall',
    to: 'webcall:x',
    isTest: true,
    source: { kind: 'agent' },
    timestamps: { queuedAt: new Date() },
    ...over,
  });

describe('calls maintenance', () => {
  it('reaps calls of a dead process and stale queued calls', async () => {
    const accountId = new Types.ObjectId();
    await fund(accountId);
    const answeredBilling = new CallBilling(
      accountId.toString(),
      new Types.ObjectId().toString(),
      false,
    );
    await answeredBilling.hold();
    const dead = await makeCall({
      accountId,
      status: 'in_progress',
      holdId: new Types.ObjectId(answeredBilling.holdId ?? ''),
      timestamps: { queuedAt: new Date(), answeredAt: new Date(Date.now() - 900_000) },
    });
    const ringingBilling = new CallBilling(
      accountId.toString(),
      new Types.ObjectId().toString(),
      false,
    );
    await ringingBilling.hold();
    const ringing = await makeCall({
      accountId,
      status: 'ringing',
      holdId: new Types.ObjectId(ringingBilling.holdId ?? ''),
    });
    const alive = await makeCall({ accountId, status: 'in_progress' });
    await registry.register(alive._id.toString(), accountId.toString(), Date.now(), 30);
    const queued = await makeCall({ accountId, status: 'queued' });
    await CallModel.collection.updateMany(
      { _id: { $in: [dead._id, ringing._id, alive._id, queued._id] } },
      {
        $set: {
          updatedAt: new Date(Date.now() - 600_000),
          createdAt: new Date(Date.now() - 3_600_000),
        },
      },
    );
    const out = await reapCalls(registry, logger);
    expect(out).toEqual({ failed: 2, canceled: 1 });
    const after = await CallModel.find({ accountId }).lean<CallDoc[]>();
    const byId = new Map(after.map((c) => [c._id.toString(), c]));
    expect(byId.get(dead._id.toString())).toMatchObject({
      status: 'failed',
      endReason: 'server_shutdown',
    });
    expect(byId.get(dead._id.toString())?.durationSec).toBeGreaterThan(100);
    expect(byId.get(ringing._id.toString())).toMatchObject({ status: 'failed', durationSec: 0 });
    expect(byId.get(alive._id.toString())?.status).toBe('in_progress');
    expect(byId.get(queued._id.toString())).toMatchObject({
      status: 'canceled',
      endReason: 'canceled',
    });
    // a hold that can't be settled is logged, the call still ends
    const broken = await makeCall({
      accountId,
      status: 'in_progress',
      holdId: new Types.ObjectId(),
      timestamps: { queuedAt: new Date(), answeredAt: new Date() },
    });
    await CallModel.collection.updateOne(
      { _id: broken._id },
      { $set: { updatedAt: new Date(Date.now() - 600_000) } },
    );
    expect((await reapCalls(registry, logger)).failed).toBe(1);
  });

  it('purges old calls with their recording, events, transcript and run', async () => {
    const accountId = new Types.ObjectId();
    const key = `accounts/${accountId.toString()}/recordings/old.wav`;
    await storage.put(key, Buffer.from('x'), { contentType: 'audio/wav' });
    const run = await FlowRunModel.create({
      accountId,
      flowId: new Types.ObjectId(),
      mode: 'call',
      versionRef: 1,
      graphChecksum: 'x',
    });
    const old = await makeCall({
      accountId,
      status: 'completed',
      recording: { fileKey: key, durationSec: 1, sizeBytes: 1, format: 'wav' },
      flowRunId: run._id,
    });
    const plain = await makeCall({ accountId, status: 'completed' });
    const fresh = await makeCall({ accountId, status: 'completed' });
    await CallEventModel.create({
      accountId,
      callId: old._id,
      seq: 1,
      type: 'status',
      at: new Date(),
    });
    await TranscriptTurnModel.create({
      accountId,
      callId: old._id,
      seq: 1,
      speaker: 'bot',
      text: 'x',
      source: 'tts',
    });
    await CallModel.collection.updateMany(
      { _id: { $in: [old._id, plain._id] } },
      { $set: { createdAt: new Date('2025-01-01') } },
    );
    expect(await purgeCalls(storage, 180)).toEqual({ calls: 2 });
    expect(await storage.exists(key)).toBe(false);
    expect(await CallEventModel.countDocuments({ callId: old._id })).toBe(0);
    expect(await TranscriptTurnModel.countDocuments({ callId: old._id })).toBe(0);
    expect(await FlowRunModel.countDocuments({ _id: run._id })).toBe(0);
    expect(await CallModel.exists({ _id: fresh._id })).toBeTruthy();
    expect(await purgeCalls(undefined, 180)).toEqual({ calls: 0 });
  });

  it('the maintenance worker runs the call jobs', async () => {
    const run = processMaintenanceJob({ logger, storage, registry });
    await expect(run({ name: CALLS_REAPER_JOB } as never)).resolves.toEqual(
      expect.objectContaining({ failed: expect.any(Number) as number }),
    );
    await expect(run({ name: CALLS_PURGE_JOB } as never)).resolves.toEqual({ calls: 0 });
    await TtsCacheModel.create({
      key: 'k',
      model: 'm',
      voice: 'v',
      language: 'hi',
      chars: 1,
      fileKey: 'tts-cache/k.pcm',
      durationMs: 1,
      lastUsedAt: new Date('2020-01-01'),
    });
    await expect(run({ name: TTS_CACHE_PURGE_JOB } as never)).resolves.toEqual({ entries: 1 });
    await expect(
      processMaintenanceJob({ logger })({ name: CALLS_REAPER_JOB } as never),
    ).resolves.toBeDefined();
  });
});
