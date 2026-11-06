import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AriClient } from '../../src/core/telephony/sip/ari-client';
import { PortPool } from '../../src/core/telephony/sip/port-pool';
import { SipTelephonyProvider } from '../../src/core/telephony/sip/provider';
import { WebCallLeg } from '../../src/core/telephony/webcall';
import { FakeClock, systemClock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { PhoneNumberModel, defaultInbound } from '../../src/db/models/phone-number.model';
import { CallManager } from '../../src/modules/calls/call.service';
import {
  createInboundSip,
  type InboundSipService,
} from '../../src/modules/calls/inbound/inbound.service';
import { normalizeCaller, normalizeDid } from '../../src/modules/calls/inbound/numbers';
import { CallRegistry } from '../../src/modules/calls/registry';
import { CallControlBus } from '../../src/modules/whatsapp-calling/bus';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { ensureRateCard, fakeChannel, fund, scriptOf } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

import { FakeAri, waitFor } from './fake-ari';

/** Phase 20 (P20-T4/T5): incoming phone calls end to end on a fake Asterisk. */

useTestDb();
const storage = useTempStorage();
const prefix = `${uniquePrefix('sip-inb')}:`;
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-sip-in-'));
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
let redis: Redis;
let sub: Redis;
let ari: FakeAri;
let client: AriClient;
let asterisk: Socket;
let manager: CallManager;
let bus: CallControlBus;
let inbound: InboundSipService;
let clock: FakeClock;
let online: string[] = [];
let t: TestAccount;
let agentA: string;
let agentB: string;
const agentId = new Types.ObjectId();
const DID = '+911600000001';
let seq = 0;

beforeAll(async () => {
  const connection = await requireRedis();
  redis = connection.client;
  sub = new Redis(connection.url);
  await ensureRateCard();
  t = await createTestAccount({ name: 'Inbound Co', voiceLine: 'sip' });
  await fund(t.account._id);
  await AccountModel.updateOne(
    { _id: t.account._id },
    { $set: { 'settings.recordingEnabled': false } },
  );
  agentA = (await t.addUser('agent')).user._id.toString();
  agentB = (await t.addUser('agent')).user._id.toString();
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
    app: 'cav-api',
    extraApps: ['cav-inbound'],
  });
  client.connect();
  await waitFor(() => client.connected);
  const sip = new SipTelephonyProvider(client, new PortPool(33200, 33299), systemClock, {
    trunk: 'trunk',
    format: 'ulaw',
    ringTimeoutSec: 40,
    mediaTimeoutSec: 30,
    rtpBindHost: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    asteriskRtpHost: '127.0.0.1',
    defaultCallerId: '+911600000000',
    app: 'cav-api',
  });
  manager = new CallManager({
    logger,
    registry: new CallRegistry(redis, prefix),
    tts: new TtsCache({ tts: new FakeTts(), storage }),
    storage,
    recordingDir,
    // the AI says nothing and ends after a moment
    scriptFor: () =>
      Promise.resolve({
        script: scriptOf(() => new Promise((r) => setTimeout(() => r(), 1200))),
        voice: 'coral',
        language: 'hinglish',
      }),
    sip,
  });
  bus = new CallControlBus({ redis, subscriber: sub, prefix, nodeId: 'inbound-node' });
  await bus.start();
  manager.attachBus(bus);
  clock = new FakeClock(Date.now());
  inbound = createInboundSip({
    line: sip,
    manager,
    bus,
    redis,
    prefix,
    logger,
    clock,
    env: {
      TELEPHONY_PROVIDER: 'sip',
      SIP_INBOUND_PER_CALLER_PER_HOUR: 3,
      SIP_INBOUND_RING_MAX_SEC: 120,
    },
    tickets: {
      issue: () => Promise.resolve({ ticket: 'tk', expiresAt: new Date().toISOString() }),
    },
    onlineUsers: () => Promise.resolve(online),
    lines: { walletLow: 'Band', noAgent: 'Koi nahi' },
  });
  sip.onIncoming((call) => inbound.handleIncoming(call));
});

afterAll(async () => {
  await manager.shutdown();
  await bus.stop();
  client.close();
  asterisk.close();
  await ari.stop();
  await flushPrefix(redis, prefix);
  sub.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
});

const setNumber = async (over: Record<string, unknown> = {}) => {
  await PhoneNumberModel.deleteMany({});
  await PhoneNumberModel.create({
    number: DID,
    kind: '1600',
    accountId: t.account._id,
    purpose: 'inbound',
    label: 'Support',
    inbound: {
      ...defaultInbound(),
      enabled: true,
      route: 'ai',
      program: { kind: 'agent', id: agentId },
      ...over,
    },
  });
};

beforeEach(async () => {
  online = [];
  await setNumber();
});

/** A trunk call: a fresh Asterisk channel id and caller each time (no spam counter). */
const ring = (caller = `9190000${String(10000 + (seq += 1)).slice(-5)}`, did = '911600000001') => {
  // fixed width: `callsTo` matches by path prefix
  const channelId = `in-${String((seq += 1)).padStart(5, '0')}`;
  ari.send({
    type: 'StasisStart',
    channel: { id: channelId, state: 'Ring', caller: { number: caller } },
    args: [did, caller],
  });
  return { channelId, caller: `+${caller}` };
};

const callOf = async (caller: string): Promise<CallDoc> => {
  for (let i = 0; i < 200; i += 1) {
    const doc = await CallModel.findOne({ direction: 'inbound', from: caller })
      .sort({ createdAt: -1 })
      .lean<CallDoc>();
    if (doc) return doc;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no call');
};

/** Ends the channel the way Asterisk does once we (or the caller) hung up. */
const destroyedAfterHangup = async (channelId: string) => {
  await waitFor(() => ari.callsTo('DELETE', `/channels/${channelId}`).length > 0, 8000);
  ari.send({ type: 'ChannelDestroyed', channel: { id: channelId }, cause: 16, cause_txt: '' });
};

/** The call once it ended and (for missed calls) its callback entry is written. */
const final = async (id: Types.ObjectId | string, missed = false) => {
  for (let i = 0; i < 300; i += 1) {
    const doc = await CallModel.findById(id).lean<CallDoc>();
    if (doc?.timestamps.endedAt && (!missed || doc.missed)) {
      // listeners (missed calls, metrics) run right after the end
      await new Promise((r) => setTimeout(r, 150));
      return (await CallModel.findById(id).lean<CallDoc>())!;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('call did not end');
};

describe('trunk numbers (P20-T4)', () => {
  it('normalises dialed and calling numbers; hidden callers are null', () => {
    expect(
      [
        '+911600000001',
        '911600000001',
        '01600000001',
        '1600000001',
        'sip:+911600000001@1.2.3.4',
      ].map(normalizeDid),
    ).toEqual(Array(5).fill('+911600000001'));
    expect(['anonymous', 'Restricted', '', 'abc'].map(normalizeCaller)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe('incoming phone calls (P20-T4)', () => {
  it('refuses a number that takes no calls (no call is recorded)', async () => {
    const before = await CallModel.countDocuments({});
    const { channelId } = ring(undefined, '911600009999');
    await waitFor(() => ari.callsTo('DELETE', `/channels/${channelId}`).length === 1);
    expect(ari.callsTo('DELETE', `/channels/${channelId}`)[0]?.query.reason).toBe('rejected');
    expect(await CallModel.countDocuments({})).toBe(before);
  });

  it('AI route: answers, runs the program, charges incoming minutes, makes the contact', async () => {
    const { channelId, caller } = ring();
    await waitFor(() => ari.callsTo('POST', `/channels/${channelId}/answer`).length === 1, 5000);
    const call = await callOf(caller);
    expect(call).toMatchObject({
      direction: 'inbound',
      provider: 'sip',
      mode: 'ai',
      from: caller,
      to: DID,
      source: { kind: 'agent', agentId },
      inbound: { did: DID, numberLabel: 'Support', route: 'ai', callerHidden: false },
    });
    expect(ari.callsTo('POST', `/channels/${channelId}/ring`)).toHaveLength(1);
    const contact = await ContactModel.findOne({ phoneE164: caller }).lean();
    expect(contact?.source.type).toBe('inbound_call');
    expect(call.contactId?.toString()).toBe(contact?._id.toString());
    await destroyedAfterHangup(channelId);
    const done = await final(call._id);
    expect(done.status).toBe('completed');
    expect(done.missed ?? null).toBeNull();
    const charge = await LedgerEntryModel.findOne({
      'ref.id': call._id.toString(),
      type: 'call_charge',
      status: 'captured',
    }).lean();
    expect(charge?.breakdown?.telephonyMicros ?? 0).toBeGreaterThan(0);
  });

  it('after hours (message): says the line, never charges, lists a missed call + bell', async () => {
    await setNumber({
      callHours: { enabled: true, timezone: 'Asia/Kolkata', weekly: [], holidays: [] },
      afterHours: { action: 'message', message: 'Band' },
    });
    const { channelId, caller } = ring();
    await waitFor(() => ari.callsTo('POST', `/channels/${channelId}/answer`).length === 1, 5000);
    const call = await callOf(caller);
    await destroyedAfterHangup(channelId);
    const done = await final(call._id, true);
    expect(done.missed).toMatchObject({ reason: 'after_hours', callback: { status: 'open' } });
    expect(done.endReason).toBe('outside_call_hours');
    expect(
      await LedgerEntryModel.countDocuments({ 'ref.id': call._id.toString(), type: 'call_charge' }),
    ).toBe(0);
    // the bell is written right after the missed entry
    let bells = 0;
    for (let i = 0; i < 100 && bells === 0; i += 1) {
      bells = await NotificationModel.countDocuments({
        accountId: t.account._id,
        type: 'call.sip_missed',
      });
      if (!bells) await new Promise((r) => setTimeout(r, 25));
    }
    expect(bells).toBeGreaterThan(0);
  });

  it('after hours (hang up) and too many calls from one caller: refused, recorded', async () => {
    await setNumber({
      callHours: { enabled: true, timezone: 'Asia/Kolkata', weekly: [], holidays: [] },
      afterHours: { action: 'hangup', message: 'x' },
    });
    const first = ring('919000077777');
    await waitFor(() => ari.callsTo('DELETE', `/channels/${first.channelId}`).length === 1);
    expect(ari.callsTo('DELETE', `/channels/${first.channelId}`)[0]?.query.reason).toBe('rejected');
    await setNumber({
      callHours: { enabled: true, timezone: 'Asia/Kolkata', weekly: [], holidays: [] },
      afterHours: { action: 'hangup', message: 'x' },
    });
    // the limit is 3 per hour: of calls 2–4, two pass the guard and one is busy
    const burst = [ring('919000077777'), ring('919000077777'), ring('919000077777')];
    const reasons = () =>
      burst.flatMap((b) =>
        ari.callsTo('DELETE', `/channels/${b.channelId}`).map((c) => c.query.reason),
      );
    await waitFor(() => reasons().length === 3);
    // whichever of the three counted last is over the limit
    expect(reasons().sort()).toEqual(['busy', 'rejected', 'rejected']);
    await waitFor(() => true);
    let spamCall: CallDoc | null = null;
    for (let i = 0; i < 100 && !spamCall; i += 1) {
      spamCall = await CallModel.findOne({ 'missed.reason': 'spam' }).lean<CallDoc>();
      if (!spamCall) await new Promise((res) => setTimeout(res, 25));
    }
    expect(spamCall).toMatchObject({ status: 'busy', endReason: 'spam_guard' });
    expect(spamCall?.missed?.callback.status).toBe('done');
    expect(await CallModel.countDocuments({ 'missed.reason': 'after_hours' })).toBeGreaterThan(0);
  });
});

describe('ringing the team (P20-T5)', () => {
  it('first answer wins; the browser joins, the caller is answered and bridged', async () => {
    await setNumber({ route: 'team', program: null });
    online = [agentA, agentB];
    const { channelId, caller } = ring();
    const call = await callOf(caller);
    await waitFor(() => inbound.live === 1);
    // no greeting: the caller keeps ringing until a person is there
    expect(ari.callsTo('POST', `/channels/${channelId}/answer`)).toHaveLength(0);
    const cmd = (userId: string, action: 'answer' | 'decline') =>
      bus.command({
        callId: call._id.toString(),
        accountId: t.account._id.toString(),
        userId,
        action,
      });
    for (let i = 0; i < 50; i += 1) {
      try {
        await cmd(agentA, 'answer');
        break;
      } catch (err) {
        // the ring (and the bus registration) start a moment after the call doc
        const code = (err as { code?: string }).code;
        if (code !== 'CALL_NOT_RINGING' && code !== 'CALL_NOT_ACTIVE') throw err;
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await expect(cmd(agentB, 'answer')).rejects.toMatchObject({ code: 'CALL_NOT_RINGING' });
    const browser = new WebCallLeg(fakeChannel().channel, systemClock);
    const actor = { callId: call._id.toString(), accountId: t.account._id.toString() };
    expect((await manager.attach({ ...actor, userId: agentB }, browser)).ok).toBe(false);
    expect((await manager.attach({ ...actor, userId: agentA }, browser)).ok).toBe(true);
    await waitFor(() => ari.callsTo('POST', `/channels/${channelId}/answer`).length === 1, 5000);
    expect(await CallModel.findById(call._id).lean<CallDoc>()).toMatchObject({
      mode: 'human',
      agentUserId: new Types.ObjectId(agentA),
    });
    ari.send({ type: 'ChannelDestroyed', channel: { id: channelId }, cause: 16, cause_txt: '' });
    const done = await final(call._id);
    expect(done.missed ?? null).toBeNull();
  });

  it('nobody answers in time → the "nobody free" line, a missed call and a bell', async () => {
    await setNumber({ route: 'team', program: null, ringTimeoutSec: 10 });
    online = [agentA];
    const { channelId, caller } = ring();
    const call = await callOf(caller);
    await waitFor(() => inbound.live === 1);
    await new Promise((r) => setTimeout(r, 100));
    clock.advance(10_001);
    await waitFor(() => ari.callsTo('POST', `/channels/${channelId}/answer`).length === 1, 5000);
    await destroyedAfterHangup(channelId);
    const done = await final(call._id, true);
    expect(done.missed).toMatchObject({ reason: 'no_answer', callback: { status: 'open' } });
    let bells = 0;
    for (let i = 0; i < 100 && bells === 0; i += 1) {
      bells = await NotificationModel.countDocuments({
        type: 'call.sip_missed',
        userId: new Types.ObjectId(agentA),
      });
      if (!bells) await new Promise((r) => setTimeout(r, 25));
    }
    expect(bells).toBeGreaterThan(0);
  });

  it('team then AI with nobody online: the AI takes it (not a missed call)', async () => {
    await setNumber({ route: 'team_then_ai' });
    online = [];
    const { channelId, caller } = ring();
    const call = await callOf(caller);
    await waitFor(() => ari.callsTo('POST', `/channels/${channelId}/answer`).length === 1, 5000);
    await destroyedAfterHangup(channelId);
    const done = await final(call._id);
    expect(done.missed ?? null).toBeNull();
    expect(done.mode).toBe('ai');
  });
});
