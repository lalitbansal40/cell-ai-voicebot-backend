import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebCallLeg } from '../../src/core/telephony/webcall';
import { systemClock } from '../../src/core/voice/clock';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { CallRegistry } from '../../src/modules/calls/registry';
import type { CallIO, CallScript } from '../../src/modules/calls/session';
import { findOrCreateWhatsAppContact } from '../../src/modules/inbox/contacts';
import { CallControlBus } from '../../src/modules/whatsapp-calling/bus';
import { NO_AGENT_LINE } from '../../src/modules/whatsapp-calling/calls.service';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard, emptyResult, fakeChannel } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { createAgentDoc } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

useTestDb();
useCapturedEmail();
const world = useInboxWorld({ FAKE_META_CALL_DELAYS_MS: '20,40,80' });
const { state } = world;
const prefix = `${uniquePrefix('wa-in')}:`;
const recordingDir = mkdtempSync(join(tmpdir(), 'cav-wa-in-'));
let redis: Redis;
let sub: Redis;
let otherSub: Redis;
let bus: CallControlBus;
let other: CallControlBus;
let runtime: CallingRuntime;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
let online: string[] = [];
let sequence = 0;
let transfer = false;
let currentIo: CallIO | null = null;
let transferResult: string | null = null;
let tts: TtsCache;

const program = (): CallScript => {
  let finish: () => void = () => undefined;
  return {
    run: (io) =>
      new Promise((resolve) => {
        currentIo = io;
        finish = () => resolve('transferred');
        if (transfer)
          void io.leg.transfer('', 30).then((r) => {
            transferResult = r;
            if (r === 'connected') finish();
          });
      }),
    stop: () => {
      finish();
      return Promise.resolve();
    },
    result: () => emptyResult({ aiSeconds: 1 }),
  };
};

beforeAll(async () => {
  const connection = await requireRedis();
  redis = connection.client;
  sub = new Redis(connection.url);
  otherSub = new Redis(connection.url);
  bus = new CallControlBus({ redis, subscriber: sub, prefix, nodeId: 'in-media' });
  other = new CallControlBus({ redis, subscriber: otherSub, prefix, nodeId: 'in-api' });
  await bus.start();
  await other.start();
  await ensureRateCard();
  tts = new TtsCache({ tts: new FakeTts(), storage: world.storage });
  runtime = createCallingRuntime({
    ctx: world.w.ctx,
    service: world.w.svc,
    inbox: state.ix,
    bus,
    calls: {
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
      registry: new CallRegistry(redis, prefix),
      tts,
      storage: world.storage,
      recordingDir,
      scriptFor: () => Promise.resolve({ script: program(), voice: 'coral', language: 'hinglish' }),
      onlineUsers: () => Promise.resolve(online),
      peer: { bindAddress: '127.0.0.1' },
      tickets: {
        issue: () =>
          Promise.resolve({ ticket: 'wst_inbound', expiresAt: new Date().toISOString() }),
      },
    },
  });
  state.h.calling = runtime.hooks;
  world.w.fake.setWebhookEmitter(async (payload) => {
    await world.deliver(payload);
  });
});

afterAll(async () => {
  await runtime.calls?.shutdown();
  await world.w.fake.stopCalls();
  await bus.stop();
  await other.stop();
  sub.disconnect();
  otherSub.disconnect();
  await flushPrefix(redis, prefix);
  rmSync(recordingDir, { recursive: true, force: true });
});

beforeEach(async () => {
  ({ users } = await world.setup());
  transfer = false;
  transferResult = null;
  currentIo = null;
  online = [users.agent.user._id.toString(), users.manager.user._id.toString()];
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    { $set: { 'calling.status': 'enabled' } },
  );
  await world.w.fake.updateCallingSettings(state.token, state.channel.phoneNumberId ?? '', {
    status: 'ENABLED',
  });
});

const calls = () => runtime.calls!;
const query = (id: string) => CallModel.findById(id).lean<CallDoc>();
const command = (
  callId: string,
  action: 'answer' | 'decline',
  userId = users.agent.user._id.toString(),
) => other.command({ callId, action, accountId: state.acc.account._id.toString(), userId });

const incoming = async () => {
  sequence += 1;
  const { waCallId } = await world.w.fake.userCall(
    state.channel.phoneNumberId ?? '',
    `91900008${String(sequence).padStart(5, '0')}`,
  );
  const call = await CallModel.findOne({ 'whatsapp.waCallId': waCallId }).lean<CallDoc>();
  expect(call).toBeTruthy();
  return { id: call!._id.toString(), waCallId, call: call! };
};

const waitRing = (id: string) =>
  vi.waitFor(() => expect(calls().liveCall(id)?.ring).not.toBeNull(), { timeout: 10_000 });
const ended = (id: string) =>
  vi.waitFor(
    async () => {
      const row = await query(id);
      expect(['completed', 'failed', 'canceled', 'no_answer']).toContain(row?.status);
      return row!;
    },
    { timeout: 10_000 },
  );
const attach = (id: string, userId = users.agent.user._id.toString()) => {
  const channel = fakeChannel();
  const leg = new WebCallLeg(channel.channel, systemClock);
  leg.receiveControl({ type: 'call.ready', sampleRate: 24_000 });
  return calls().attachAgent(
    { callId: id, accountId: state.acc.account._id.toString(), userId },
    leg,
  );
};

describe('user-initiated WhatsApp calls', () => {
  it('rings the team, answers once across nodes, waits for the agent microphone and bills no Meta charge', async () => {
    const call = await incoming();
    await waitRing(call.id);
    const results = await Promise.allSettled([
      command(call.id, 'answer'),
      command(call.id, 'answer', users.manager.user._id.toString()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winning = (await query(call.id))!.agentUserId!.toString();
    expect((await query(call.id))?.timestamps.answeredAt).toBeNull();
    expect(await attach(call.id, winning)).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await query(call.id))?.status).toBe('in_progress'));
    expect(await attach(call.id, winning)).toMatchObject({ ok: false });
    await world.w.fake.userHangup(call.waCallId);
    await ended(call.id);
    await vi.waitFor(async () =>
      expect(await MessageModel.exists({ 'call.callId': call.id })).toBeTruthy(),
    );
    expect((await MessageModel.findOne({ 'call.callId': call.id }).lean())?.call).toMatchObject({
      direction: 'in',
      outcome: 'completed',
    });
    expect(
      await LedgerEntryModel.countDocuments({ 'ref.id': call.id, type: 'whatsapp_call_charge' }),
    ).toBe(0);
    const chat = await ConversationModel.findById(call.call.whatsapp?.conversationId).lean();
    expect(chat?.windowExpiresAt).toBeNull();
  });

  it('declines for one user, then ends as missed when everyone declines', async () => {
    const call = await incoming();
    await waitRing(call.id);
    await command(call.id, 'decline');
    expect((await query(call.id))?.status).toBe('ringing');
    await command(call.id, 'decline', users.manager.user._id.toString());
    await ended(call.id);
    await vi.waitFor(async () =>
      expect((await MessageModel.findOne({ 'call.callId': call.id }).lean())?.call?.outcome).toBe(
        'missed',
      ),
    );
    await expect(command(call.id, 'answer')).rejects.toBeTruthy();
  });

  it('rejects a call outside opening hours and an AI call with no wallet funds', async () => {
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      {
        $set: {
          'calling.callHours': {
            enabled: true,
            timezone: 'Asia/Kolkata',
            weekly: [],
            holidays: [],
          },
        },
      },
    );
    const closed = await incoming();
    expect((await ended(closed.id)).endReason).toBe('outside_call_hours');
    const agentId = await createAgentDoc(state.acc.account._id, 'Inbound');
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      {
        $set: {
          'calling.callHours.enabled': false,
          'calling.inbound.route': 'ai',
          'calling.inbound.aiProgram': { kind: 'agent', id: agentId },
        },
      },
    );
    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 0, creditLimitMicros: 0 } },
    );
    const poor = await incoming();
    expect((await ended(poor.id)).endReason).toBe('wallet_empty');
    expect(
      (await WalletModel.findOne({ accountId: state.acc.account._id }).lean())?.holdMicros,
    ).toBe(0);
  });

  it('answers AI calls and transfers an AI call to a browser agent on the same recording/session', async () => {
    const agentId = await createAgentDoc(state.acc.account._id, 'Handoff');
    transfer = true;
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.whatsappCalling.recordCalls': false } },
    );
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      {
        $set: {
          'calling.inbound.route': 'ai_then_team',
          'calling.inbound.aiProgram': { kind: 'agent', id: agentId },
        },
      },
    );
    const call = await incoming();
    await waitRing(call.id);
    expect(currentIo).not.toBeNull();
    await command(call.id, 'answer');
    expect(await attach(call.id)).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await query(call.id))?.mode).toBe('human'));
    expect((await query(call.id))?.whatsapp?.transferredTo?.toString()).toBe(
      users.agent.user._id.toString(),
    );
    expect((await query(call.id))?.status).toBe('in_progress');
    await world.w.fake.userHangup(call.waCallId);
    await ended(call.id);
  });

  it('ends missed with no eligible online users and rejects a different tenant command', async () => {
    online = [];
    const call = await incoming();
    expect((await ended(call.id)).endReason).toBe('no_agent_available');
    await expect(
      other.command({
        callId: call.id,
        action: 'answer',
        accountId: new Types.ObjectId().toString(),
        userId: users.agent.user._id.toString(),
      }),
    ).rejects.toBeTruthy();
  });
  it('times out the ring: rejected as missed with a bell for the ring list; a late answer is not ringing', async () => {
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.inbound.ringTimeoutSec': 1 } },
    );
    const call = await incoming();
    await waitRing(call.id);
    expect((await query(call.id))?.whatsapp?.ringUserIds?.map(String).sort()).toEqual(
      [...online].sort(),
    );
    expect((await ended(call.id)).endReason).toBe('no_agent_available');
    await vi.waitFor(async () =>
      expect((await MessageModel.findOne({ 'call.callId': call.id }).lean())?.call?.outcome).toBe(
        'missed',
      ),
    );
    await vi.waitFor(async () =>
      expect(
        (
          await NotificationModel.find({
            accountId: state.acc.account._id,
            type: 'call.whatsapp_missed',
          }).lean()
        )
          .map((n) => n.userId.toString())
          .sort(),
      ).toEqual([...online].sort()),
    );
    expect(world.w.fake.calls.map((c) => c.op)).toContain('rejectCall');
    await expect(
      calls().command({
        callId: call.id,
        action: 'answer',
        accountId: state.acc.account._id.toString(),
        userId: users.agent.user._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CALL_NOT_RINGING' });
  });

  it('the customer hangs up while ringing: the ring ends and nobody can answer', async () => {
    const seen = world.w.fake.calls.length;
    const call = await incoming();
    await waitRing(call.id);
    await world.w.fake.userHangup(call.waCallId);
    const row = await ended(call.id);
    expect(row.timestamps.answeredAt).toBeNull();
    expect(calls().liveCall(call.id)?.ring ?? null).toBeNull();
    await vi.waitFor(async () =>
      expect((await MessageModel.findOne({ 'call.callId': call.id }).lean())?.call?.outcome).toBe(
        'missed',
      ),
    );
    await expect(
      calls().command({
        callId: call.id,
        action: 'answer',
        accountId: state.acc.account._id.toString(),
        userId: users.agent.user._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CALL_NOT_RINGING' });
    expect(world.w.fake.calls.slice(seen).map((c) => c.op)).not.toContain('acceptCall');
  });

  it('pre-accepts with the answer it later accepts (the fake fails a different SDP)', async () => {
    const call = await incoming();
    await waitRing(call.id);
    expect(calls().liveCall(call.id)?.answerSdp).toBeTruthy();
    const ops = () => world.w.fake.calls.map((c) => c.op);
    expect(ops()).toContain('preAcceptCall');
    await command(call.id, 'answer');
    expect(await attach(call.id)).toEqual({ ok: true });
    await vi.waitFor(async () => expect((await query(call.id))?.status).toBe('in_progress'));
    expect(ops()).toContain('acceptCall');
    const views = await world.w.fake.fakeCalls(state.channel.phoneNumberId ?? '');
    expect(views.find((v) => v.waCallId === call.waCallId)?.state).not.toBe('ended');
    await world.w.fake.userHangup(call.waCallId);
    await ended(call.id);
  });

  it('a terminate before the claim: the late connect starts nothing', async () => {
    const waCallId = `wacid.early-${String(Date.now())}`;
    const envelope = (event: Record<string, unknown>) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: state.channel.wabaId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'calls',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: (state.channel.displayPhoneNumber ?? '').replace(/\D/g, ''),
                  phone_number_id: state.channel.phoneNumberId,
                },
                calls: [
                  {
                    id: waCallId,
                    from: '919000077001',
                    to: (state.channel.displayPhoneNumber ?? '').replace(/\D/g, ''),
                    direction: 'USER_INITIATED',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    ...event,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const seen = world.w.fake.calls.length;
    await world.deliver(envelope({ event: 'terminate', status: 'FAILED' }));
    await world.deliver(
      envelope({ event: 'connect', session: { sdp_type: 'offer', sdp: 'v=0\r\n' } }),
    );
    expect(await CallModel.exists({ 'whatsapp.waCallId': waCallId })).toBeNull();
    expect(world.w.fake.calls.slice(seen).map((c) => c.op)).not.toContain('preAcceptCall');
  });

  it('matches a BSUID-only caller, refuses an unknown one without a contact, and stores the payloads', async () => {
    const known = await findOrCreateWhatsAppContact({
      accountId: state.acc.account._id,
      waId: '919000066001',
    });
    await ContactModel.updateOne({ _id: known._id }, { $set: { 'whatsapp.bsuid': 'IN.known01' } });
    const { waCallId } = await world.w.fake.userCall(
      state.channel.phoneNumberId ?? '',
      '919000066001',
      {
        bsuid: 'IN.known01',
        withoutPhone: true,
        ctaPayload: 'cta-loan',
        deeplinkPayload: 'dl-home',
      },
    );
    const row = await CallModel.findOne({ 'whatsapp.waCallId': waCallId }).lean<CallDoc>();
    expect(row?.contactId?.toString()).toBe(known._id.toString());
    expect(row?.whatsapp).toMatchObject({ ctaPayload: 'cta-loan', deeplinkPayload: 'dl-home' });
    await world.w.fake.userHangup(waCallId);
    await ended(row!._id.toString());

    const before = await ContactModel.countDocuments({ accountId: state.acc.account._id });
    const stranger = await world.w.fake.userCall(
      state.channel.phoneNumberId ?? '',
      '919000066002',
      { bsuid: 'IN.unknown02', withoutPhone: true },
    );
    expect(await CallModel.exists({ 'whatsapp.waCallId': stranger.waCallId })).toBeNull();
    expect(await ContactModel.countDocuments({ accountId: state.acc.account._id })).toBe(before);
    expect(world.w.fake.calls.map((c) => c.op)).toContain('rejectCall');
  });

  it('a transfer nobody takes: the agent program hears the "no one free" line and goes on', async () => {
    const agentId = await createAgentDoc(state.acc.account._id, 'Nobody');
    transfer = true;
    online = [];
    const real = tts.get.bind(tts);
    // the real line plays ~6 s in real time; a 100 ms clip keeps the test about the routing
    const said = vi
      .spyOn(tts, 'get')
      .mockImplementation((req) =>
        req.text === NO_AGENT_LINE
          ? Promise.resolve({ pcm: new Int16Array(2400), cached: false })
          : real(req),
      );
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      {
        $set: {
          'calling.inbound.route': 'ai_then_team',
          'calling.inbound.aiProgram': { kind: 'agent', id: agentId },
        },
      },
    );
    const call = await incoming();
    await vi.waitFor(() => expect(transferResult).toBe('failed'), { timeout: 10_000 });
    expect(said.mock.calls.some(([req]) => req.text === NO_AGENT_LINE)).toBe(true);
    const row = await query(call.id);
    expect(row).toMatchObject({ status: 'in_progress', mode: 'ai' });
    expect(row?.whatsapp?.transferredTo ?? null).toBeNull();
    said.mockRestore();
    await world.w.fake.userHangup(call.waCallId);
    await ended(call.id);
  });
});
