import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAKE_PINNACLE_KEY_PREFIXES, providerUnsupported } from '../../src/core/meta';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { CallModel, type CallDoc } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { CallRegistry } from '../../src/modules/calls/registry';
import type { CallIO, CallScript } from '../../src/modules/calls/session';
import { sealSecret } from '../../src/modules/whatsapp/context';
import { CallControlBus } from '../../src/modules/whatsapp-calling/bus';
import { createCallingReadiness } from '../../src/modules/whatsapp-calling/readiness';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../src/modules/whatsapp-calling/runtime';
import { createLogger, setLogger } from '../../src/shared/logger';
import { createTestAccount } from '../helpers/auth';
import { emptyResult, ensureRateCard } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { createAgentDoc } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { expectNoUdpHandles } from '../helpers/udp';

useTestDb();
useCapturedEmail();
const world = useInboxWorld({
  FAKE_META_CALL_DELAYS_MS: '20,40,80',
  PINNACLE_ENABLED: 'true',
  // calls at any hour (the fake Meta outside production)
  WA_CALL_WINDOW_IGNORED: 'true',
});
const { state } = world;
const prefix = `${uniquePrefix('wa-pn')}:`;
const recordingDir = mkdtempSync(join(tmpdir(), 'cav-wa-pn-'));
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

let redis: Redis;
let sub: Redis;
let bus: CallControlBus;
let runtime: CallingRuntime;
let users: Awaited<ReturnType<typeof world.setup>>['users'];
let online: string[] = [];
let currentIo: CallIO | null = null;
let sequence = 0;
let apiKey = '';

/** An AI program that waits until the customer hangs up. */
const program = (): CallScript => {
  let finish: () => void = () => undefined;
  return {
    run: (io) =>
      new Promise((resolve) => {
        currentIo = io;
        finish = () => resolve('transferred');
      }),
    stop: () => {
      finish();
      return Promise.resolve();
    },
    result: () => emptyResult({ aiSeconds: 1 }),
  };
};

beforeAll(async () => {
  setLogger(logger);
  const connection = await requireRedis();
  redis = connection.client;
  sub = new Redis(connection.url);
  bus = new CallControlBus({ redis, subscriber: sub, prefix, nodeId: 'pn-media' });
  await bus.start();
  await ensureRateCard();
  const platform = await createTestAccount({
    isPlatform: true,
    slug: `platform-pn-calls-${String(Date.now())}`,
    name: 'Platform',
  });
  await platform.addUser('owner', { platformRole: 'superadmin' });
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
      scriptFor: () => Promise.resolve({ script: program(), voice: 'coral', language: 'hinglish' }),
      onlineUsers: () => Promise.resolve(online),
      peer: { bindAddress: '127.0.0.1' },
      tickets: {
        issue: () => Promise.resolve({ ticket: 'wst_pn', expiresAt: new Date().toISOString() }),
      },
    },
  });
  state.h.calling = runtime.hooks;
  // the fake's call events reach us the way a managed number's would: the partner relay
  world.w.fake.setWebhookEmitter(async (payload) => {
    await world.deliver(payload);
  });
});

afterAll(async () => {
  await runtime.calls?.shutdown();
  await world.w.fake.stopCalls();
  await bus.stop();
  sub.disconnect();
  await flushPrefix(redis, prefix);
  rmSync(recordingDir, { recursive: true, force: true });
  setLogger(undefined);
  await expectNoUdpHandles();
});

/** A connected number turned into a managed (Pinnacle) one with calling on. */
const managed = async (keyPrefix: string = FAKE_PINNACLE_KEY_PREFIXES.valid) => {
  const setup = await world.setup();
  users = setup.users;
  const number = await world.w.pinnacle.seedManagedNumber({
    businessName: setup.signup.businessName,
    phone: setup.signup.phone,
    keyPrefix,
  });
  apiKey = number.apiKey;
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    {
      $set: {
        provider: 'pinnacle',
        tokenSealed: sealSecret(world.w.ctx, number.apiKey),
        'calling.status': 'enabled',
        creditLine: { status: 'partner_active', allocationConfigId: null, error: null, at: null },
        pinnacle: {
          webhookSecretSealed: null,
          webhookUrl: null,
          webhookSetAt: new Date(),
          keyLast4: number.apiKey.slice(-4),
          keyCheckedAt: new Date(),
          lastBalanceErrorAt: null,
          addedBy: null,
        },
      },
    },
  );
  await world.w.fake.updateCallingSettings(state.token, state.channel.phoneNumberId ?? '', {
    status: 'ENABLED',
  });
  state.channel = (await WhatsAppChannelModel.findById(state.channel._id)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>())!;
  world.w.pinnacle.calls.length = 0;
  currentIo = null;
};

const calls = () => runtime.calls!;
const query = (id: string) => CallModel.findById(id).lean<CallDoc>();
const ended = (id: string) =>
  vi.waitFor(
    async () => {
      const row = await query(id);
      expect(['completed', 'failed', 'canceled', 'no_answer', 'busy']).toContain(row?.status);
      return row!;
    },
    { timeout: 15_000, interval: 50 },
  );
const pinOps = () => world.w.pinnacle.calls.map((c) => c.op);

const incoming = async () => {
  sequence += 1;
  const { waCallId } = await world.w.fake.userCall(
    state.channel.phoneNumberId ?? '',
    `91900006${String(sequence).padStart(5, '0')}`,
  );
  const call = await vi.waitFor(
    async () => {
      const row = await CallModel.findOne({ 'whatsapp.waCallId': waCallId }).lean<CallDoc>();
      expect(row).toBeTruthy();
      return row!;
    },
    { timeout: 10_000 },
  );
  return { id: call._id.toString(), waCallId };
};

const aiRoute = async (route: 'ai' | 'team_then_ai') => {
  const agentId = await createAgentDoc(state.acc.account._id, 'Managed AI');
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    {
      $set: {
        'calling.inbound.route': route,
        'calling.inbound.aiProgram': { kind: 'agent', id: agentId },
      },
    },
  );
  return agentId;
};

describe('WhatsApp calling on a managed (Pinnacle) number (PN-T7)', () => {
  beforeEach(async () => {
    await redis.del('wa:pinnacle:balance-alert');
  });

  it('incoming call answered by the AI: pre_accept / accept / terminate go to the partner', async () => {
    await managed();
    await aiRoute('ai');
    const call = await incoming();
    await vi.waitFor(() => expect(currentIo).not.toBeNull(), { timeout: 10_000 });
    expect(pinOps()).toEqual(expect.arrayContaining(['preAcceptCall', 'acceptCall']));
    await world.w.fake.userHangup(call.waCallId);
    expect((await ended(call.id)).status).toBe('completed');
  });

  it('team then AI: nobody online → the AI answers on the partner line', async () => {
    await managed();
    const agentId = await aiRoute('team_then_ai');
    online = [];
    const call = await incoming();
    await vi.waitFor(() => expect(currentIo).not.toBeNull(), { timeout: 10_000 });
    expect(await query(call.id)).toMatchObject({
      mode: 'ai',
      source: { kind: 'agent', agentId: new Types.ObjectId(agentId) },
    });
    expect(pinOps()).toContain('acceptCall');
    await world.w.fake.userHangup(call.waCallId);
    await ended(call.id);
  });

  it('outgoing AI call: connect goes to the partner, the connect webhook comes back through the relay', async () => {
    await managed();
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      {
        $set: {
          'settings.callingWindow': { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
        },
      },
    );
    sequence += 1;
    const waId = `91900005${String(sequence).padStart(5, '0')}`;
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${waId}`,
      source: { type: 'manual' },
    });
    await world.w.fake.setCallPermission(state.channel.phoneNumberId ?? '', waId, 'temporary');
    const res = await calls().startOutbound(
      {
        type: 'user',
        id: users.agent.user._id,
        accountId: state.acc.account._id,
        userId: users.agent.user._id,
      },
      {
        channelId: state.channel._id.toString(),
        contactId: contact._id.toString(),
        mode: 'ai',
        program: { kind: 'agent', id: await createAgentDoc(state.acc.account._id, 'Out') },
      },
    );
    expect(pinOps()).toContain('startCall');
    await vi.waitFor(() => expect(currentIo).not.toBeNull(), { timeout: 15_000 });
    const row = await query(res.callId);
    if (row?.whatsapp?.waCallId) await world.w.fake.userHangup(row.whatsapp.waCallId);
    await ended(res.callId);
  });

  it('partner balance low on an outgoing call: failed, superadmins rung once', async () => {
    await managed(FAKE_PINNACLE_KEY_PREFIXES.balanceLow);
    sequence += 1;
    const waId = `91900004${String(sequence).padStart(5, '0')}`;
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${waId}`,
      source: { type: 'manual' },
    });
    await world.w.fake.setCallPermission(state.channel.phoneNumberId ?? '', waId, 'temporary');
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      {
        $set: {
          'settings.callingWindow': { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
        },
      },
    );
    const outcome = await calls()
      .startOutbound(
        {
          type: 'user',
          id: users.agent.user._id,
          accountId: state.acc.account._id,
          userId: users.agent.user._id,
        },
        {
          channelId: state.channel._id.toString(),
          contactId: contact._id.toString(),
          mode: 'human',
        },
      )
      .catch((err: unknown) => err);
    expect(outcome).toMatchObject({ code: 'WA_PROVIDER_BALANCE_LOW' });
    expect(
      await NotificationModel.countDocuments({ type: 'whatsapp.provider_balance_low' }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await WhatsAppChannelModel.findById(state.channel._id).lean())?.pinnacle?.lastBalanceErrorAt,
    ).toBeInstanceOf(Date);
  });

  it('settings: the partner refusing calling → unavailable (provider_unsupported), 422', async () => {
    await managed();
    world.w.pinnacle.failNext(
      'updateCallingSettings',
      providerUnsupported('updateCallingSettings'),
    );
    const err: unknown = await runtime.settings
      .updateCalling(
        { type: 'user', id: users.owner.user._id },
        state.acc.account._id,
        state.channel._id.toString(),
        { callIconVisibility: 'DISABLE_ALL' },
      )
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'WA_PROVIDER_UNSUPPORTED' });
    expect((await WhatsAppChannelModel.findById(state.channel._id).lean())?.calling).toMatchObject({
      status: 'unavailable',
      unavailableReason: 'provider_unsupported',
    });
  });

  it('readiness: partner webhook / key items, never our Meta app checks', async () => {
    await managed();
    world.w.fake.calls.length = 0;
    const readiness = createCallingReadiness({
      ctx: world.w.ctx,
      token: () => Promise.resolve({ token: apiKey }),
    });
    const ch = (await WhatsAppChannelModel.findById(state.channel._id).lean<WhatsAppChannelDoc>())!;
    const { items } = await readiness.read(ch);
    expect(items.find((i) => i.key === 'calls_webhook')).toMatchObject({
      ok: true,
      detail: 'Partner webhook set — calls events reach us',
    });
    expect(items.find((i) => i.key === 'app_permission')).toMatchObject({
      ok: true,
      detail: 'Partner API key valid',
    });
    const ops = world.w.fake.calls.map((c) => c.op);
    expect(ops).not.toContain('getAppSubscriptions');
    expect(ops).not.toContain('debugToken');
  });
});
