import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AriClient } from '../../src/core/telephony/sip/ari-client';
import { PortPool } from '../../src/core/telephony/sip/port-pool';
import { SipTelephonyProvider } from '../../src/core/telephony/sip/provider';
import { systemClock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { CallManager, type StartOutboundCallInput } from '../../src/modules/calls/call.service';
import { CallRegistry } from '../../src/modules/calls/registry';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { ensureRateCard, fund, scriptOf } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

import { FakeAri, waitFor } from './fake-ari';

useTestDb();
const storage = useTempStorage();
const prefix = `${uniquePrefix('sip-out')}:`;
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-sip-out-'));
let redis: Redis;
let ari: FakeAri;
let client: AriClient;
let asterisk: Socket;
let manager: CallManager;
let t: TestAccount;
let broke: TestAccount;

beforeAll(async () => {
  redis = (await requireRedis()).client;
  await ensureRateCard();
  t = await createTestAccount({ name: 'Sip Co' });
  broke = await createTestAccount({ name: 'Broke Co' });
  await fund(t.account._id);
  // no recording notice: the bot's only line would take real seconds on the paced line
  await AccountModel.updateOne(
    { _id: t.account._id },
    { $set: { 'settings.recordingEnabled': false } },
  );
  ari = await new FakeAri().start();
  asterisk = createSocket('udp4');
  await new Promise<void>((r) => asterisk.bind(0, '127.0.0.1', r));
  ari.on((c) =>
    c.path === '/channels/externalMedia'
      ? {
          status: 200,
          body: {
            id: c.query.channelId,
            channelvars: { UNICASTRTP_LOCAL_PORT: String(asterisk.address().port) },
          },
        }
      : undefined,
  );
  client = new AriClient({
    url: ari.url,
    user: 'cav',
    password: 'x'.repeat(24),
    app: 'cav-worker',
  });
  client.connect();
  await waitFor(() => client.connected);
  const sip = new SipTelephonyProvider(client, new PortPool(33000, 33099), systemClock, {
    trunk: 'trunk',
    format: 'ulaw',
    ringTimeoutSec: 40,
    mediaTimeoutSec: 30,
    rtpBindHost: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    asteriskRtpHost: '127.0.0.1',
    defaultCallerId: '+911600000000',
    app: 'cav-worker',
  });
  manager = new CallManager({
    logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    registry: new CallRegistry(redis, prefix),
    tts: new TtsCache({ tts: new FakeTts(), storage }),
    storage,
    recordingDir,
    // the bot says nothing and ends the call: enough to see the line and the money
    scriptFor: () =>
      Promise.resolve({
        script: scriptOf(() => new Promise((r) => setTimeout(() => r(), 1200))),
        voice: 'coral',
        language: 'hinglish',
      }),
    sip,
  });
});

afterAll(async () => {
  await manager.shutdown();
  client.close();
  asterisk.close();
  await ari.stop();
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
});

const input = (over: Partial<StartOutboundCallInput> = {}): StartOutboundCallInput => ({
  accountId: t.account._id.toString(),
  provider: 'sip',
  to: '+919000000001',
  contactId: new Types.ObjectId().toString(),
  source: { kind: 'flow', flowId: new Types.ObjectId() },
  variables: {},
  initiatedBy: null,
  callerId: '+911600000007',
  ...over,
});

const chan = (callId: string) => `cav-${callId}`;
const doc = async (callId: string) => (await CallModel.findById(callId).lean<CallDoc>()) as CallDoc;

describe('phone calls on the SIP line (T18.6)', () => {
  it('holds money, dials with the caller id, answers, ends and charges carrier minutes', async () => {
    const out = await manager.startOutboundCall(input());
    const call = await doc(out.callId);
    expect(call).toMatchObject({
      provider: 'sip',
      isTest: false,
      from: '+911600000007',
      callerId: '+911600000007',
      to: '+919000000001',
    });
    expect(call.holdId).not.toBeNull();
    const dial = ari.callsTo('POST', `/channels/${chan(out.callId)}`)[0]!;
    expect(dial.query).toMatchObject({
      endpoint: 'PJSIP/+919000000001@trunk',
      callerId: '+911600000007',
      app: 'cav-worker',
    });
    ari.send({
      type: 'StasisStart',
      channel: { id: chan(out.callId), state: 'Up' },
      args: [out.callId],
    });
    await waitFor(
      () =>
        ari.calls.some((c) => c.method === 'DELETE' && c.path === `/channels/${chan(out.callId)}`),
      5000,
    );
    ari.send({
      type: 'ChannelDestroyed',
      channel: { id: chan(out.callId) },
      cause: 16,
      cause_txt: '',
    });
    const summary = await out.ended;
    expect(summary.status).toBe('completed');
    const ended = await doc(out.callId);
    expect(ended.status).toBe('completed');
    const charge = await LedgerEntryModel.findOne({
      'ref.id': out.callId,
      type: 'call_charge',
      status: { $ne: 'released' },
    }).lean();
    expect(charge?.breakdown?.telephonyMicros ?? 0).toBeGreaterThan(0);
    expect(ended.cost.telephonyMicros).toBeGreaterThan(0);
    const withSip = await CallModel.findById(out.callId).lean<CallDoc>();
    expect(withSip?.sip).toMatchObject({ codec: 'ulaw', sipQ850: 16 });
  });

  it('a busy number releases the hold and charges nothing', async () => {
    const out = await manager.startOutboundCall(input({ to: '+919000000002' }));
    ari.send({
      type: 'ChannelDestroyed',
      channel: { id: chan(out.callId) },
      cause: 17,
      cause_txt: '',
    });
    const summary = await out.ended;
    expect(summary.status).toBe('busy');
    const rows = await LedgerEntryModel.find({ 'ref.id': out.callId }).lean();
    expect(rows.map((r) => [r.type, r.status, r.releaseReason])).toEqual([
      ['call_charge', 'released', 'not_answered'],
    ]);
    expect((await doc(out.callId)).endReason).toBe('busy');
  });

  it('refuses when the wallet cannot hold the call and leaves no call behind', async () => {
    const before = await CallModel.countDocuments({ accountId: broke.account._id });
    await expect(
      manager.startOutboundCall(input({ accountId: broke.account._id.toString() })),
    ).rejects.toMatchObject({ code: 'WALLET_INSUFFICIENT_BALANCE' });
    expect(await CallModel.countDocuments({ accountId: broke.account._id })).toBe(before);
  });

  it('refuses while the line is not connected', async () => {
    const offline = new CallManager({
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      registry: new CallRegistry(redis, prefix),
      tts: new TtsCache({ tts: new FakeTts(), storage }),
      storage: undefined,
      recordingDir,
      scriptFor: () => Promise.reject(new Error('unused')),
    });
    await expect(offline.startOutboundCall(input())).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_RUNNABLE',
    });
    await expect(
      offline.startOutboundCall({ ...input(), provider: 'dryrun' }),
    ).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_RUNNABLE' });
  });
});
