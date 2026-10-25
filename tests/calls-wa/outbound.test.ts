import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { pulsesFor } from '../../src/core/billing/whatsapp-calls';
import { FAKE_CALL_KNOBS } from '../../src/core/meta';
import type { CallLeg, HangupCause, LegStatus } from '../../src/core/telephony/types';
import { hasTone } from '../../src/core/telephony/whatsapp/tones';
import type { PlaybackResult } from '../../src/core/voice/audio/pacer';
import { tone } from '../../src/core/voice/audio/pcm';
import type { Clock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { CallRegistry } from '../../src/modules/calls/registry';
import type { CallIO, CallScript } from '../../src/modules/calls/session';
import { CallControlBus } from '../../src/modules/whatsapp-calling/bus';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { createAgentDoc } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const prefix = `${uniquePrefix('wa-out')}:`;
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-wa-out-'));
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const RATE = 24_000;

/** Real time shifted to 12:00 IST today (inside every calling window). */
const NOON_OFFSET = (() => {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  const noon =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 12, 0) - 5.5 * 3_600_000;
  return noon - now.getTime();
})();
let offset = NOON_OFFSET;
const clock: Clock = {
  now: () => Date.now() + offset,
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref();
    return t;
  },
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

let redis: Redis;
let sub: Redis;
let sub2: Redis;
let bus: CallControlBus;
let otherBus: CallControlBus;
let runtime: CallingRuntime;
let script: (call: CallDoc) => CallScript;

/** A browser agent: sends a 1 kHz tone, keeps what it hears. */
class FakeAgentLeg implements CallLeg {
  readonly rate = 24_000 as const;
  readonly heard: Int16Array[] = [];
  readonly notices: string[] = [];
  private audioFns: ((f: Int16Array) => void)[] = [];
  private dtmfFns: ((d: string) => void)[] = [];
  private statusFns: ((s: LegStatus, c?: HangupCause) => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  hungUp = false;
  onAudio(fn: (f: Int16Array) => void) {
    this.audioFns.push(fn);
  }
  onDtmf(fn: (d: string) => void) {
    this.dtmfFns.push(fn);
  }
  onText() {
    // no typed text
  }
  onStatus(fn: (s: LegStatus, c?: HangupCause) => void) {
    this.statusFns.push(fn);
  }
  onOutgoing() {
    // not recorded here
  }
  play(pcm: Int16Array): Promise<PlaybackResult> {
    this.heard.push(pcm);
    return Promise.resolve({ completed: true, playedMs: 20 });
  }
  clearAudio() {
    return 0;
  }
  get playing() {
    return false;
  }
  transfer() {
    return Promise.resolve('failed' as const);
  }
  notify(n: { type: string }) {
    this.notices.push(n.type);
  }
  hangup() {
    this.hungUp = true;
    if (this.timer) clearInterval(this.timer);
    return Promise.resolve();
  }
  talk() {
    const t = tone(60_000, RATE, { hz: 1_000, amplitude: 8_000 });
    let o = 0;
    this.timer = setInterval(() => {
      const frame = t.subarray(o, o + 480);
      o = (o + 480) % (t.length - 480);
      for (const fn of this.audioFns) fn(frame);
    }, 20);
    this.timer.unref();
  }
  press(d: string) {
    for (const fn of this.dtmfFns) fn(d);
  }
  leave() {
    for (const fn of this.statusFns) fn('ended', 'customer_hangup');
  }
}

/** The AI program of these tests: waits for the customer's key, `1` → Paid. */
const keyScript = (): CallScript => {
  let disposition: string | null = null;
  let stop: () => void = () => undefined;
  return {
    run: (io: CallIO) =>
      new Promise((resolve) => {
        stop = () => resolve('hangup_node');
        io.leg.onDtmf((d) => {
          disposition = d === '1' ? 'Paid' : 'Other';
          resolve('hangup_node');
        });
        void io.leg.play(tone(400, RATE, { hz: 1_000, amplitude: 8_000 }));
      }),
    stop: () => {
      stop();
      return Promise.resolve();
    },
    result: () => ({
      outcome: { key: disposition },
      disposition,
      variables: {},
      flowRunId: null,
      aiSeconds: 0,
      languageDetected: null,
    }),
  };
};

beforeAll(async () => {
  ({ client: redis } = await requireRedis());
  await ensureRateCard();
  const url = (await requireRedis()).url;
  sub = new Redis(url);
  sub2 = new Redis(url);
  bus = new CallControlBus({ redis, subscriber: sub, prefix, nodeId: 'media-1' });
  otherBus = new CallControlBus({ redis, subscriber: sub2, prefix, nodeId: 'api-2' });
  await bus.start();
  await otherBus.start();
  script = () => keyScript();
  runtime = createCallingRuntime({
    ctx: world.w.ctx,
    service: world.w.svc,
    inbox: state.ix,
    bus,
    calls: {
      logger,
      registry: new CallRegistry(redis, prefix),
      tts: new TtsCache({ tts: new FakeTts(), storage: world.storage }),
      storage: world.storage,
      recordingDir,
      scriptFor: (call) =>
        Promise.resolve({ script: script(call), voice: 'coral', language: 'hinglish' }),
      peer: { bindAddress: '127.0.0.1' },
      tickets: {
        issue: () => Promise.resolve({ ticket: 'wst_test', expiresAt: new Date().toISOString() }),
      },
      clock,
      bicRingTimeoutSec: 3,
    },
  });
  state.h.calling = runtime.hooks;
  world.w.fake.setWebhookEmitter(async (body) => {
    await world.deliver(body);
  });
});
afterAll(async () => {
  await runtime.calls?.shutdown();
  await world.w.fake.stopCalls();
  await bus.stop();
  await otherBus.stop();
  sub.disconnect();
  sub2.disconnect();
  await flushPrefix(redis, prefix);
  rmSync(recordingDir, { recursive: true, force: true });
});

const calls = () => {
  if (!runtime.calls) throw new Error('no calls');
  return runtime.calls;
};
const customer = (knob: string) => `91900007${knob}`;

describe('business-initiated WhatsApp calls', () => {
  let users: Awaited<ReturnType<typeof world.setup>>['users'];
  let actor: {
    type: 'user';
    id: Types.ObjectId;
    accountId: Types.ObjectId;
    userId: Types.ObjectId;
  };
  beforeEach(async () => {
    offset = NOON_OFFSET;
    ({ users } = await world.setup());
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.status': 'enabled' } },
    );
    await world.w.fake.updateCallingSettings(state.token, state.channel.phoneNumberId ?? '', {
      status: 'ENABLED',
    });
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      {
        $set: {
          'settings.callingWindow': { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
        },
      },
    );
    actor = {
      type: 'user',
      id: users.agent.user._id,
      accountId: state.acc.account._id,
      userId: users.agent.user._id,
    };
  });

  const contactFor = async (waId: string, allow = true) => {
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${waId}`,
      source: { type: 'manual' },
    });
    if (allow)
      await world.w.fake.setCallPermission(state.channel.phoneNumberId ?? '', waId, 'temporary');
    return contact;
  };
  const start = (
    contactId: Types.ObjectId,
    mode: 'human' | 'ai' = 'human',
    program?: { kind: 'flow' | 'agent'; id: string },
  ) =>
    calls().startOutbound(actor, {
      channelId: state.channel._id.toString(),
      contactId: contactId.toString(),
      mode,
      ...(program ? { program } : {}),
    });
  const callOf = (id: string) => CallModel.findById(id).lean<CallDoc>();
  const ended = (id: string) =>
    vi.waitFor(
      async () => {
        const c = await callOf(id);
        expect(['completed', 'failed', 'no_answer', 'busy', 'canceled']).toContain(c?.status);
        return c!;
      },
      { timeout: 20_000, interval: 50 },
    );
  const ledger = (callId: string) =>
    LedgerEntryModel.find({ 'ref.id': callId }).sort({ createdAt: 1 }).lean();

  it('agent call: audio both ways through the bridge, hang up from another server, Meta duration billed in pulses', async () => {
    const contact = await contactFor(customer('00041'));
    const res = await start(contact._id, 'human');
    expect(res).toMatchObject({
      callId: expect.any(String) as string,
      mediaTicket: expect.any(String) as string,
    });
    const agent = new FakeAgentLeg();
    // another user can't take the agent socket; the caller can (once)
    expect(
      await calls().attachAgent(
        {
          callId: res.callId,
          accountId: actor.accountId.toString(),
          userId: users.manager.user._id.toString(),
        },
        agent,
      ),
    ).toMatchObject({ ok: false });
    expect(
      await calls().attachAgent(
        {
          callId: res.callId,
          accountId: actor.accountId.toString(),
          userId: actor.userId.toString(),
        },
        agent,
      ),
    ).toEqual({ ok: true });
    agent.talk();
    await vi.waitFor(async () => expect((await callOf(res.callId))?.status).toBe('in_progress'), {
      timeout: 10_000,
    });
    const live = await callOf(res.callId);
    expect(live?.whatsapp?.waCallId).toMatch(/^wacid\./);
    expect(live?.whatsapp?.timeline.map((t) => t.event)).toEqual(
      expect.arrayContaining(['queued', 'dialed', 'connect', 'ringing', 'accepted']),
    );
    // the customer heard the agent (after the recording notice); the agent heard the customer
    await vi.waitFor(
      async () => {
        const view = (await world.w.fake.fakeCalls(state.channel.phoneNumberId ?? '')).find(
          (c) => c.waCallId === live?.whatsapp?.waCallId,
        );
        expect(view?.heardTone).toBe(true);
      },
      { timeout: 15_000, interval: 100 },
    );
    const heard = agent.heard.slice(-40);
    const all = new Int16Array(heard.reduce((n, h) => n + h.length, 0));
    let o = 0;
    for (const h of heard) {
      all.set(h, o);
      o += h.length;
    }
    expect(hasTone(all, RATE, 440, 1_000)).toBe(true);
    // keypad → the customer (RFC 4733)
    agent.press('7');
    await vi.waitFor(async () =>
      expect(
        (await world.w.fake.fakeCalls(state.channel.phoneNumberId ?? '')).find(
          (c) => c.waCallId === live?.whatsapp?.waCallId,
        )?.connected,
      ).toBe(true),
    );
    // another server hangs up through the call bus
    expect(await otherBus.hangup(res.callId)).toBe('forwarded');
    const done = await ended(res.callId);
    expect(done).toMatchObject({
      status: 'completed',
      endReason: 'customer_hangup',
      mode: 'human',
    });
    expect(agent.hungUp).toBe(true);
    // Meta's terminate (duration from ACCEPTED) → the call charge in pulses
    await vi.waitFor(
      async () => expect((await callOf(res.callId))?.billing.whatsapp?.status).toBe('settled'),
      { timeout: 10_000 },
    );
    const after = await callOf(res.callId);
    const rows = await ledger(res.callId);
    const charge = rows.find((r) => r.type === 'whatsapp_call_charge' && r.status === 'captured');
    expect(charge?.breakdown).toMatchObject({
      waMarket: 'IN',
      waPulses: pulsesFor(after?.whatsapp?.metaDuration ?? 0),
    });
    expect(after?.billing.whatsapp?.pulses).toBe(pulsesFor(after?.whatsapp?.metaDuration ?? 0));
    expect(after?.cost.telephonyMicros).toBe(charge?.amountMicros);
    expect(rows.filter((r) => r.status === 'held')).toHaveLength(0);
    const wallet = await WalletModel.findOne({ accountId: actor.accountId }).lean();
    expect(wallet?.holdMicros).toBe(0);
    // the call bubble in the chat
    const bubble = await MessageModel.findOne({ type: 'call', contactId: contact._id }).lean();
    expect(bubble?.call).toMatchObject({ direction: 'out', outcome: 'completed', mode: 'human' });
    expect(
      await AuditLogModel.exists({ action: 'call.whatsapp_started', 'target.id': res.callId }),
    ).toBeTruthy();
    // a connected call resets the streak
    const perm = await WhatsAppCallPermissionModel.findOne({ contactId: contact._id }).lean();
    expect(perm?.unansweredStreak).toBe(0);
  });

  it('AI call: the customer presses 1 (knob 00028) → Paid; the call + AI holds are both settled', async () => {
    const contact = await contactFor(customer(FAKE_CALL_KNOBS.pressesOne));
    const res = await start(contact._id, 'ai', { kind: 'agent', id: await agentId() });
    const done = await ended(res.callId);
    expect(done).toMatchObject({ status: 'completed', mode: 'ai', disposition: 'Paid' });
    await vi.waitFor(
      async () => expect((await callOf(res.callId))?.billing.whatsapp?.status).toBe('settled'),
      {
        timeout: 10_000,
      },
    );
    const rows = await ledger(res.callId);
    expect(rows.filter((r) => r.status === 'held')).toHaveLength(0);
    expect(new Set(rows.map((r) => r.type))).toEqual(
      new Set(['whatsapp_call_charge', 'call_charge']),
    );
  });

  it('rejected (00021) and not answered (00022): holds released, no charge, bubble, unanswered streak', async () => {
    const rejects = await contactFor(customer(FAKE_CALL_KNOBS.rejects));
    const r = await start(rejects._id);
    const done = await ended(r.callId);
    expect(done.endReason).toBe('rejected_by_customer');
    const never = await contactFor(customer(FAKE_CALL_KNOBS.neverAnswers));
    const n = await start(never._id);
    const missed = await ended(n.callId);
    expect(missed.endReason).toBe('not_answered');
    for (const id of [r.callId, n.callId]) {
      await vi.waitFor(async () =>
        expect((await callOf(id))?.billing.whatsapp?.status).toBe('released'),
      );
      const rows = await ledger(id);
      expect(rows.some((x) => x.status === 'captured')).toBe(false);
    }
    expect(
      (await MessageModel.findOne({ type: 'call', contactId: rejects._id }).lean())?.call?.outcome,
    ).toBe('rejected');
    expect(
      (await MessageModel.findOne({ type: 'call', contactId: never._id }).lean())?.call?.outcome,
    ).toBe('no_answer');
    expect(
      (await WhatsAppCallPermissionModel.findOne({ contactId: never._id }).lean())
        ?.unansweredStreak,
    ).toBe(1);
    // we sent terminate for the unanswered one
    expect(world.w.fake.calls.map((c) => c.op)).toContain('terminateCall');
    expect((await WalletModel.findOne({ accountId: actor.accountId }).lean())?.holdMicros).toBe(0);
  });

  it('the customer hangs up after 5 s (00027): ended by Meta, 1 pulse charged', async () => {
    const contact = await contactFor(customer(FAKE_CALL_KNOBS.hangsUpAfter5s));
    const res = await start(contact._id, 'ai', { kind: 'agent', id: await agentId() });
    const done = await ended(res.callId);
    expect(done.endReason).toBe('customer_hangup');
    await vi.waitFor(
      async () => expect((await callOf(res.callId))?.billing.whatsapp?.status).toBe('settled'),
      {
        timeout: 10_000,
      },
    );
    const c = await callOf(res.callId);
    expect(c?.whatsapp?.metaDuration).toBe(5);
    expect(c?.billing.whatsapp?.pulses).toBe(1);
  });

  it('WA_CALL_WINDOW_IGNORED (fake Meta, dev / E2E): a night call is placed', async () => {
    const env = world.w.ctx.env;
    const night = await contactFor(customer(FAKE_CALL_KNOBS.rejects));
    offset = NOON_OFFSET + 10.5 * 3_600_000; // 22:30 IST
    try {
      await expect(start(night._id)).rejects.toMatchObject({ code: 'CALL_OUTSIDE_WINDOW' });
      world.w.ctx.env = { ...env, WA_CALL_WINDOW_IGNORED: true };
      const res = await start(night._id);
      expect((await ended(res.callId)).endReason).toBe('rejected_by_customer');
    } finally {
      world.w.ctx.env = env;
      offset = NOON_OFFSET;
    }
  });

  it('refusals before dialing: connect failure, no permission, wallet, DND, opt-out, window, active call, limits', async () => {
    const fails = await contactFor(customer(FAKE_CALL_KNOBS.connectFails));
    await expect(start(fails._id)).rejects.toMatchObject({ code: 'WHATSAPP_CALL_FAILED' });
    const failed = await CallModel.findOne({ contactId: fails._id }).lean<CallDoc>();
    expect(failed).toMatchObject({ status: 'failed', endReason: 'meta_failed' });
    expect(failed?.billing.whatsapp?.status).toBe('released');
    expect((await WalletModel.findOne({ accountId: actor.accountId }).lean())?.holdMicros).toBe(0);

    const meta = await contactFor(customer(FAKE_CALL_KNOBS.noPermission));
    await expect(start(meta._id)).rejects.toMatchObject({
      code: 'WHATSAPP_CALL_PERMISSION_MISSING',
    });
    const none = await contactFor(customer('00071'), false);
    await expect(start(none._id)).rejects.toMatchObject({
      code: 'WHATSAPP_CALL_PERMISSION_MISSING',
    });
    expect(await CallModel.exists({ contactId: { $in: [meta._id, none._id] } })).toBeNull();

    const dnd = await contactFor(customer('00072'));
    await ContactModel.updateOne({ _id: dnd._id }, { $set: { dnd: true } });
    await expect(start(dnd._id)).rejects.toMatchObject({ code: 'CALL_NOT_ALLOWED' });
    const out = await contactFor(customer('00073'));
    await ContactModel.updateOne({ _id: out._id }, { $set: { optedOutAt: new Date() } });
    await expect(start(out._id)).rejects.toMatchObject({ code: 'CALL_NOT_ALLOWED' });

    const later = await contactFor(customer('00074'));
    offset = NOON_OFFSET + 10.5 * 3_600_000; // 22:30 IST
    await expect(start(later._id)).rejects.toMatchObject({ code: 'CALL_OUTSIDE_WINDOW' });
    offset = NOON_OFFSET;

    await AccountModel.updateOne(
      { _id: actor.accountId },
      { $set: { 'limits.maxConcurrentCalls': 0 } },
    );
    await expect(start(later._id)).rejects.toMatchObject({ code: 'CALL_LIMIT_REACHED' });
    await AccountModel.updateOne(
      { _id: actor.accountId },
      { $set: { 'limits.maxConcurrentCalls': 10 } },
    );

    // one live call per customer
    const busy = await contactFor(customer(FAKE_CALL_KNOBS.neverAnswers));
    const first = await start(busy._id);
    await expect(start(busy._id)).rejects.toMatchObject({ code: 'WHATSAPP_CALL_ACTIVE' });
    await ended(first.callId);

    // an empty wallet refuses the hold: no call row
    await WalletModel.updateOne(
      { accountId: actor.accountId },
      { $set: { balanceMicros: 0, creditLimitMicros: 0 } },
    );
    const poor = await contactFor(customer('00075'));
    await expect(start(poor._id)).rejects.toMatchObject({ code: 'WALLET_INSUFFICIENT_BALANCE' });
    expect(await CallModel.exists({ contactId: poor._id })).toBeNull();

    // calling off on the number
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.status': 'disabled' } },
    );
    await expect(start(poor._id)).rejects.toMatchObject({ code: 'WHATSAPP_CALLING_DISABLED' });
    // impersonators never call
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.status': 'enabled' } },
    );
    await expect(
      calls().startOutbound(
        { ...actor, impersonatorId: new Types.ObjectId() },
        { channelId: state.channel._id.toString(), contactId: poor._id.toString(), mode: 'human' },
      ),
    ).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });

  it('hold puts the bridge on hold; an unknown call refuses hold', async () => {
    const contact = await contactFor(customer('00076'));
    const res = await start(contact._id, 'human');
    const agent = new FakeAgentLeg();
    await calls().attachAgent(
      {
        callId: res.callId,
        accountId: actor.accountId.toString(),
        userId: actor.userId.toString(),
      },
      agent,
    );
    await vi.waitFor(async () => expect((await callOf(res.callId))?.status).toBe('in_progress'), {
      timeout: 10_000,
    });
    expect(await calls().setHold(actor.accountId, res.callId, true)).toEqual({ onHold: true });
    expect(agent.notices).toContain('call.hold');
    expect(await calls().setHold(actor.accountId, res.callId, false)).toEqual({ onHold: false });
    await expect(
      calls().setHold(actor.accountId, new Types.ObjectId().toString(), true),
    ).rejects.toMatchObject({
      code: 'CALL_NOT_ACTIVE',
    });
    // the agent leaves → the call ends
    agent.leave();
    const done = await ended(res.callId);
    expect(done.endReason).toBe('agent_end_call');
  });
});

/** An active AI agent of the current test account (the program of AI calls). */
const agentId = () => createAgentDoc(state.acc.account._id, 'Caller');
