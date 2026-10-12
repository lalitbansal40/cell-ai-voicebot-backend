import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CALL_LINES } from '../../src/config/limits';
import { FakeClock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { CallEventModel } from '../../src/db/models/call-event.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { CallManager } from '../../src/modules/calls/call.service';
import { CallRegistry } from '../../src/modules/calls/registry';
import type { CallIO, CallScript } from '../../src/modules/calls/session';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { answer, ensureRateCard, fund, makeLeg, pumpUntil, scriptOf, talk } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

useTestDb();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-rec-test-'));
const prefix = `${uniquePrefix('calls')}:`;
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
let redis: Redis;
let registry: CallRegistry;
let t: TestAccount;
let owner: TestUser;

beforeAll(async () => {
  redis = (await requireRedis()).client;
  registry = new CallRegistry(redis, prefix);
  await ensureRateCard();
  t = await createTestAccount();
  owner = await t.addUser('owner');
  await fund(t.account._id);
});
afterAll(async () => {
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
});

const tickets = { issue: vi.fn(() => Promise.resolve({ ticket: 'wst_test', expiresAt: 'x' })) };

const manager = (script: () => CallScript, clock: FakeClock, tts = new FakeTts()) =>
  new CallManager({
    logger,
    registry,
    tts: new TtsCache({ tts, storage }),
    storage,
    recordingDir,
    tickets,
    clock,
    scriptFor: () => Promise.resolve({ script: script(), voice: 'coral', language: 'hinglish' }),
  });

const create = (m: CallManager, accountId = t.account._id, userId = owner.user._id) =>
  m.createWebCall({
    accountId: accountId.toString(),
    userId: userId.toString(),
    source: { kind: 'agent', agentId: new Types.ObjectId() },
    contactId: null,
    variables: { name: 'Asha' },
  });

const callOf = async (id: string) => (await CallModel.findById(id).lean<CallDoc>()) as CallDoc;

const until = async (
  clock: FakeClock,
  leg: ReturnType<typeof makeLeg>['leg'],
  check: () => Promise<boolean>,
  maxMs = 60_000,
) => {
  expect(await pumpUntil(clock, leg, check, maxMs)).toBe(true);
};

describe('CallSession — a full web test call', () => {
  it('hold → socket → answered → notice + script lines → ended, settled, recorded, persisted', async () => {
    const clock = new FakeClock(Date.parse('2026-10-12T10:00:00Z'));
    const script = scriptOf(
      async (io: CallIO) => {
        await io.say('Namaste Asha');
        io.transcript('customer', 'haan ji', { source: 'stt', language: 'hi' });
        io.customerDone();
        await io.say('Dhanyavaad');
        return 'hangup_node';
      },
      { disposition: 'paid', outcome: { disposition: 'paid' }, aiSeconds: 4 },
    );
    const m = manager(() => script, clock);
    const ended: string[] = [];
    m.onCallEnded((s) => ended.push(`${s.status}:${s.endReason}`));
    const created = await create(m);
    const callId = created.callId;
    expect(created).toMatchObject({ mediaTicket: 'wst_test', wsPath: '/ws/media' });
    expect(tickets.issue).toHaveBeenCalledWith(
      expect.objectContaining({ callId, channel: 'media', userId: owner.user._id.toString() }),
    );
    const queued = await callOf(callId);
    expect(queued).toMatchObject({
      status: 'queued',
      isTest: true,
      provider: 'webcall',
      to: `webcall:${owner.user._id.toString()}`,
    });
    expect(queued.holdId).not.toBeNull();
    expect(await registry.liveCalls(t.account._id.toString())).toContain(callId);
    expect(m.load).toBe(1);

    const { leg, json, binary, closed } = makeLeg(clock);
    expect(
      await m.attach(
        { callId, accountId: t.account._id.toString(), userId: owner.user._id.toString() },
        leg,
      ),
    ).toEqual({ ok: true });
    expect(m.isLiveHere(callId)).toBe(true);
    expect((await callOf(callId)).status).toBe('ringing');
    answer(leg);
    await until(clock, leg, async () => (await callOf(callId)).status === 'completed');

    const done = await callOf(callId);
    expect(done).toMatchObject({
      status: 'completed',
      endReason: 'hangup_node',
      disposition: 'paid',
      outcome: { disposition: 'paid' },
    });
    expect(done.durationSec).toBeGreaterThan(3);
    expect(done.cost.telephonyMicros).toBe(0);
    expect(done.cost.totalMicros).toBeGreaterThan(0);
    expect(done.cost.totalMicros).toBe(
      done.cost.aiMicros + done.cost.ttsMicros + done.cost.commissionMicros,
    );
    expect(done.ledgerEntryId).not.toBeNull();
    expect(done.metrics.ttsChars).toBe(
      CALL_LINES.recordingNotice.length + 'Namaste Asha'.length + 'Dhanyavaad'.length,
    );
    expect(done.metrics.aiSeconds).toBe(4);
    expect(done.metrics.latency.samples).toBe(1);
    expect(done.metrics.framesOut).toBe(binary.length);
    expect(done.recording).toMatchObject({
      format: 'wav',
      fileKey: `accounts/${t.account._id.toString()}/recordings/${callId}.wav`,
    });
    expect(await storage.exists(done.recording?.fileKey ?? '')).toBe(true);
    expect(readdirSync(recordingDir)).toEqual([]);

    const turns = await TranscriptTurnModel.find({ callId }).sort({ seq: 1 }).lean();
    expect(turns.map((x) => [x.speaker, x.text, x.source])).toEqual([
      ['bot', CALL_LINES.recordingNotice, 'system'],
      ['bot', 'Namaste Asha', 'tts'],
      ['customer', 'haan ji', 'stt'],
      ['bot', 'Dhanyavaad', 'tts'],
    ]);
    expect(turns[1]?.endMs).toBeGreaterThan(turns[1]?.startMs ?? 0);
    const events = await CallEventModel.find({ callId }).sort({ seq: 1 }).lean();
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['status', 'tts', 'latency', 'recording_saved']),
    );
    expect(JSON.stringify(events)).not.toContain('Namaste');
    const ledger = await LedgerEntryModel.find({ 'ref.id': callId }).lean();
    expect(ledger.map((l) => l.type)).toContain('call_charge');
    expect(json.some((m) => m.type === 'call.transcript' && m.final === false)).toBe(true);
    expect(json.find((m) => m.type === 'call.ended')).toMatchObject({ reason: 'hangup_node' });
    expect(closed).toEqual([[1000, 'normal']]);
    await vi.waitFor(() => expect(ended).toEqual(['completed:hangup_node']));
    expect(await registry.liveCalls(t.account._id.toString())).not.toContain(callId);
    expect(m.isLiveHere(callId)).toBe(false);
    expect(script.stopped).toEqual(['hangup_node']);
  });
});

describe('CallManager — limits, holds and attaches', () => {
  it('3 calls per account; process capacity; a refused hold leaves no call', async () => {
    const clock = new FakeClock();
    const a = await createTestAccount();
    const user = await a.addUser('owner');
    await fund(a.account._id);
    const m = manager(() => scriptOf(() => Promise.resolve()), clock);
    for (let i = 0; i < 3; i += 1) await create(m, a.account._id, user.user._id);
    await expect(create(m, a.account._id, user.user._id)).rejects.toMatchObject({
      code: 'CALL_LIMIT_REACHED',
    });
    const full = manager(() => scriptOf(() => Promise.resolve()), clock);
    for (let i = 0; i < 20; i += 1)
      (full as unknown as { waiting: Map<string, unknown> }).waiting.set(String(i), null);
    await expect(create(full)).rejects.toMatchObject({ code: 'CALL_CAPACITY' });
    const poor = await createTestAccount();
    const poorUser = await poor.addUser('owner');
    await expect(create(m, poor.account._id, poorUser.user._id)).rejects.toMatchObject({
      code: 'WALLET_INSUFFICIENT_BALANCE',
    });
    expect(await CallModel.countDocuments({ accountId: poor.account._id })).toBe(0);
  });

  it('refuses unknown calls, other users and second attaches; cancels calls nobody connects to', async () => {
    const clock = new FakeClock();
    const m = manager(() => scriptOf(() => new Promise(() => undefined)), clock);
    const created = await create(m);
    const callId = created.callId;
    const base = { callId, accountId: t.account._id.toString(), userId: owner.user._id.toString() };
    expect(await m.attach({ ...base, callId: 'bad' }, makeLeg(clock).leg)).toMatchObject({
      ok: false,
      code: 4012,
    });
    expect(
      await m.attach({ ...base, callId: new Types.ObjectId().toString() }, makeLeg(clock).leg),
    ).toMatchObject({ ok: false, code: 4012 });
    expect(
      await m.attach({ ...base, userId: new Types.ObjectId().toString() }, makeLeg(clock).leg),
    ).toMatchObject({ ok: false, code: 4003 });
    expect(await m.attach(base, makeLeg(clock).leg)).toEqual({ ok: true });
    expect(await m.attach(base, makeLeg(clock).leg)).toMatchObject({ ok: false, code: 4012 });
    await expect(
      m.hangup(t.account._id.toString(), new Types.ObjectId().toString()),
    ).rejects.toMatchObject({ code: 'CALL_NOT_ACTIVE' });
    await expect(m.hangup(new Types.ObjectId().toString(), callId)).rejects.toMatchObject({
      code: 'CALL_NOT_ACTIVE',
    });
    // ringing without a microphone for 15 s → failed (media timeout), hold released
    await clock.tick(15_000, 1000);
    await vi.waitFor(async () => expect((await callOf(callId)).status).toBe('failed'));
    expect((await callOf(callId)).endReason).toBe('media_timeout');
    const released = await LedgerEntryModel.find({ 'ref.id': callId }).lean();
    expect(released.some((r) => r.status === 'released')).toBe(true);
    // a call nobody connects to within 75 s is canceled
    const lonely = await create(m);
    await clock.tick(75_000, 5000);
    await vi.waitFor(async () => expect((await callOf(lonely.callId)).status).toBe('canceled'));
  });
});

describe('CallSession — ways a call ends', () => {
  const run = async (
    script: CallScript,
    drive: (ctx: {
      clock: FakeClock;
      leg: ReturnType<typeof makeLeg>['leg'];
      m: CallManager;
      callId: string;
      accountId: string;
    }) => Promise<void>,
    accountId = t.account._id,
    userId = owner.user._id,
  ) => {
    const clock = new FakeClock();
    const m = manager(() => script, clock);
    const created = await create(m, accountId, userId);
    const callId = created.callId;
    const legParts = makeLeg(clock);
    await m.attach(
      { callId, accountId: accountId.toString(), userId: userId.toString() },
      legParts.leg,
    );
    answer(legParts.leg);
    await vi.waitFor(async () => expect((await callOf(callId)).status).toBe('in_progress'));
    await drive({ clock, leg: legParts.leg, m, callId, accountId: accountId.toString() });
    return { callId, ...legParts };
  };
  const waitLong = (io: CallIO) =>
    new Promise<void>((resolve) => {
      const check = () => (io.ended ? resolve() : io.clock.setTimeout(check, 200));
      check();
    });

  it('the customer hangs up; a remote hangup; a failing script', async () => {
    const a = await run(scriptOf(waitLong), async ({ clock, leg, callId }) => {
      await talk(clock, leg, 4000);
      leg.receiveControl({ type: 'call.hangup' });
      await until(clock, leg, async () => (await callOf(callId)).status === 'completed');
    });
    expect((await callOf(a.callId)).endReason).toBe('customer_hangup');
    const b = await run(scriptOf(waitLong), async ({ clock, leg, m, callId, accountId }) => {
      await talk(clock, leg, 4000);
      const summary = await m.hangup(accountId, callId);
      expect(summary).toMatchObject({ status: 'completed', endReason: 'customer_hangup' });
    });
    expect((await callOf(b.callId)).status).toBe('completed');
    const c = await run(
      scriptOf(() => Promise.reject(new Error('boom'))),
      async ({ clock, leg, callId }) => {
        await until(clock, leg, async () => (await callOf(callId)).status === 'failed');
      },
    );
    expect(await callOf(c.callId)).toMatchObject({
      endReason: 'engine_error',
      error: { code: 'engine_error' },
    });
  });

  it('silence on the socket for 30 s ends the call; shutdown says the technical line', async () => {
    const idle = await run(scriptOf(waitLong), async ({ clock, callId }) => {
      await clock.tick(40_000, 200);
      await vi.waitFor(async () => expect((await callOf(callId)).status).toBe('completed'));
    });
    expect((await callOf(idle.callId)).endReason).toBe('media_timeout');
    const tts = new FakeTts();
    const clock = new FakeClock();
    const m = manager(() => scriptOf(waitLong), clock, tts);
    const created = await create(m);
    const callId = created.callId;
    const { leg } = makeLeg(clock);
    await m.attach(
      { callId, accountId: t.account._id.toString(), userId: owner.user._id.toString() },
      leg,
    );
    answer(leg);
    await talk(clock, leg, 4000);
    const stopping = m.shutdown();
    await talk(clock, leg, 6000);
    await stopping;
    expect(await callOf(callId)).toMatchObject({ status: 'failed', endReason: 'server_shutdown' });
    expect(tts.spoken).toContain(CALL_LINES.technical);
  });

  it('runs out of money: polite line, then wallet_empty; no recording when the account turned it off', async () => {
    const poor = await createTestAccount();
    const user = await poor.addUser('owner');
    await fund(poor.account._id, 20_000_000); // ₹20: the first hold fits, an extension does not
    await AccountModel.updateOne({ _id: poor.account._id }, { 'settings.recordingEnabled': false });
    const tts = new FakeTts();
    const clock = new FakeClock();
    const m = manager(() => scriptOf(waitLong), clock, tts);
    const created = await create(m, poor.account._id, user.user._id);
    const callId = created.callId;
    const { leg } = makeLeg(clock);
    await m.attach(
      { callId, accountId: poor.account._id.toString(), userId: user.user._id.toString() },
      leg,
    );
    answer(leg);
    await until(clock, leg, async () => (await callOf(callId)).status === 'completed', 200_000);
    const done = await callOf(callId);
    expect(done).toMatchObject({ endReason: 'wallet_empty', recording: null });
    expect(tts.spoken).toContain(CALL_LINES.walletEmpty);
    expect(tts.spoken).not.toContain(CALL_LINES.recordingNotice);
    expect(
      await CallEventModel.exists({ callId, type: 'wallet_extend', 'data.ok': false }),
    ).toBeTruthy();
  });
});
