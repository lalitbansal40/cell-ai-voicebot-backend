import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel, DEFAULT_WHATSAPP_CALLING_SETTINGS } from '../../src/db/models/account.model';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { MessageModel } from '../../src/db/models/message.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import { UserModel } from '../../src/db/models/user.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import {
  callHoursProblems,
  WhatsAppChannelModel,
  type CallHours,
} from '../../src/db/models/whatsapp-channel.model';
import {
  PLACEHOLDER_CALLING_MARKETS,
  PLACEHOLDER_MARKETS,
  WhatsAppRateCardModel,
} from '../../src/db/models/whatsapp-rate-card.model';
import { useTestDb } from '../helpers/db';

useTestDb();

beforeAll(async () => {
  await WhatsAppCallPermissionModel.createIndexes();
  await CallModel.createIndexes();
  await MessageModel.createIndexes();
  await ContactModel.createIndexes();
  await WhatsAppRateCardModel.createIndexes();
});

const channel = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountId: new Types.ObjectId(),
  label: 'Support',
  provider: 'fake',
  mode: 'cloud_api',
  wabaId: '1000000001',
  metaPayer: 'platform',
  status: 'connected',
  ...over,
});

const hours = (over: Partial<CallHours> = {}): CallHours => ({
  enabled: true,
  timezone: 'Asia/Kolkata',
  weekly: [],
  holidays: [],
  ...over,
});

describe('WhatsAppChannel.calling', () => {
  it('defaults to disabled, team routing and the default request text; coexistence → unavailable', async () => {
    const cloud = await WhatsAppChannelModel.create(channel());
    expect(cloud.calling).toMatchObject({
      status: 'disabled',
      unavailableReason: null,
      callIconVisibility: 'DEFAULT',
      iconCountries: [],
      callHours: { enabled: false, timezone: 'Asia/Kolkata', weekly: [], holidays: [] },
      callbackPermission: false,
      inbound: { route: 'team', aiProgram: null, ringTimeoutSec: 30, ringUserIds: null },
      restrictions: [],
      syncedAt: null,
      lastError: null,
    });
    expect(cloud.calling?.permissionRequestBody).toContain('WhatsApp par call');
    const app = await WhatsAppChannelModel.create(channel({ mode: 'coexistence' }));
    expect(app.calling).toMatchObject({ status: 'unavailable', unavailableReason: 'coexistence' });
    // an explicit status is kept
    const set = await WhatsAppChannelModel.create(
      channel({
        mode: 'coexistence',
        calling: { status: 'unavailable', unavailableReason: 'country' },
      }),
    );
    expect(set.calling?.unavailableReason).toBe('country');
  });

  it('validates HHMM, entries per day, overlaps, holidays, countries and ring targets', async () => {
    const bad: Record<string, unknown>[] = [
      { callHours: hours({ weekly: [{ day: 'MONDAY', open: '9:00', close: '1800' }] }) },
      { callHours: hours({ weekly: [{ day: 'MONDAY', open: '2400', close: '2500' }] }) },
      { callHours: hours({ weekly: [{ day: 'FUNDAY' as never, open: '0900', close: '1800' }] }) },
      {
        callHours: hours({
          weekly: [
            { day: 'MONDAY', open: '0900', close: '1000' },
            { day: 'MONDAY', open: '1100', close: '1200' },
            { day: 'MONDAY', open: '1300', close: '1400' },
          ],
        }),
      },
      {
        callHours: hours({
          weekly: [
            { day: 'TUESDAY', open: '0900', close: '1300' },
            { day: 'TUESDAY', open: '1200', close: '1400' },
          ],
        }),
      },
      { callHours: hours({ weekly: [{ day: 'FRIDAY', open: '1800', close: '0900' }] }) },
      {
        callHours: hours({
          holidays: Array.from({ length: 21 }, (_, i) => ({
            date: `2026-12-${String(i + 1).padStart(2, '0')}`,
            start: '0000',
            end: '2359',
          })),
        }),
      },
      { callHours: hours({ holidays: [{ date: '25-12-2026', start: '0000', end: '2359' }] }) },
      { iconCountries: ['india'] },
      { iconCountries: ['IN', 'IN'] },
      { inbound: { ringUserIds: Array.from({ length: 51 }, () => new Types.ObjectId()) } },
      { inbound: { ringTimeoutSec: 5 } },
      { inbound: { route: 'robot' } },
      { permissionRequestBody: 'x'.repeat(1025) },
    ];
    for (const calling of bad) {
      await expect(WhatsAppChannelModel.validate(channel({ calling }))).rejects.toThrow();
    }
    const ok = channel({
      calling: {
        status: 'enabled',
        iconCountries: ['IN', 'AE'],
        callHours: hours({
          weekly: [
            { day: 'MONDAY', open: '0900', close: '1300' },
            { day: 'MONDAY', open: '1400', close: '1800' },
            { day: 'SATURDAY', open: '1000', close: '1400' },
          ],
          holidays: [{ date: '2026-12-25', start: '0000', end: '2359' }],
        }),
        inbound: {
          route: 'ai_then_team',
          aiProgram: { kind: 'agent', id: new Types.ObjectId() },
          ringUserIds: [new Types.ObjectId()],
        },
      },
    });
    await expect(WhatsAppChannelModel.validate(ok)).resolves.toBeDefined();
  });

  it('callHoursProblems names each problem', () => {
    expect(callHoursProblems({ weekly: [], holidays: [] })).toEqual([]);
    expect(
      callHoursProblems({
        weekly: [
          { day: 'MONDAY', open: '0900', close: '1300' },
          { day: 'MONDAY', open: '1200', close: '1400' },
          { day: 'MONDAY', open: '1500', close: '1600' },
          { day: 'SUNDAY', open: '1000', close: '1000' },
        ],
        holidays: [
          { date: '2026-12-25', start: '0000', end: '2359' },
          { date: '2026-12-25', start: '1000', end: '0900' },
        ],
      }),
    ).toEqual([
      'At most 2 time ranges on MONDAY',
      'MONDAY: time ranges overlap',
      'SUNDAY: the opening time must be before the closing time',
      '2026-12-25: the start time must be before the end time',
      '2026-12-25 is listed twice',
    ]);
  });
});

describe('WhatsAppCallPermission model', () => {
  it('one row per account × number × contact, defaults, indexes, tenant-scoped', async () => {
    const accountId = new Types.ObjectId();
    const channelId = new Types.ObjectId();
    const contactId = new Types.ObjectId();
    const row = await WhatsAppCallPermissionModel.create({ accountId, channelId, contactId });
    expect(row.toObject()).toMatchObject({
      status: 'none',
      expiresAt: null,
      source: null,
      lastRequest: null,
      requests: { day: [], week: [] },
      unansweredStreak: 0,
      connectedCallsLast24h: 0,
      metaCheckedAt: null,
      metaActions: [],
      history: [],
    });
    await expect(
      WhatsAppCallPermissionModel.create({ accountId, channelId, contactId }),
    ).rejects.toMatchObject({ code: 11000 });
    await WhatsAppCallPermissionModel.create({
      accountId,
      channelId: new Types.ObjectId(),
      contactId,
    });
    const indexes = await WhatsAppCallPermissionModel.collection.indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { accountId: 1, channelId: 1, contactId: 1 }, unique: true }),
    );
    expect(indexes).toContainEqual(
      expect.objectContaining({ key: { accountId: 1, expiresAt: 1 } }),
    );
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'temporary_expiry' }));
    expect(WhatsAppCallPermissionModel.schema.path('accountId').isRequired).toBe(true);
  });

  it('validates statuses, sources, request kinds and the 30-entry history', async () => {
    const base = {
      accountId: new Types.ObjectId(),
      channelId: new Types.ObjectId(),
      contactId: new Types.ObjectId(),
    };
    for (const over of [
      { status: 'allowed' },
      { source: 'sms' },
      { lastRequest: { messageId: new Types.ObjectId(), kind: 'sms', at: new Date() } },
      {
        history: Array.from({ length: 31 }, () => ({
          status: 'requested',
          at: new Date(),
          source: 'business',
        })),
      },
      { history: [{ status: 'requested', at: new Date(), source: 'robot' }] },
      { unansweredStreak: -1 },
    ]) {
      await expect(WhatsAppCallPermissionModel.validate({ ...base, ...over })).rejects.toThrow();
    }
    await expect(
      WhatsAppCallPermissionModel.validate({
        ...base,
        status: 'temporary',
        expiresAt: new Date(),
        source: 'request_reply',
        lastRequest: { messageId: new Types.ObjectId(), kind: 'template', at: new Date() },
        metaActions: [
          {
            action: 'start_call',
            canPerform: true,
            limits: [{ timePeriod: 'PT24H', maxAllowed: 100, currentUsage: 1 }],
          },
        ],
        history: [{ status: 'temporary', at: new Date(), source: 'request_reply' }],
      }),
    ).resolves.toBeDefined();
  });
});

describe('Call model — WhatsApp calls', () => {
  const call = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    accountId: new Types.ObjectId(),
    direction: 'inbound',
    provider: 'whatsapp',
    from: 'whatsapp',
    to: 'whatsapp',
    source: { kind: null },
    mode: 'human',
    timestamps: { queuedAt: new Date() },
    ...over,
  });

  it('defaults: ai mode, no WhatsApp parts; WhatsApp parts validate', async () => {
    const plain = await CallModel.create(call({ provider: 'webcall', mode: undefined }));
    expect(plain.mode).toBe('ai');
    expect(plain.whatsapp).toBeNull();
    expect(plain.billing).toEqual({ whatsapp: null });
    expect(plain.agentUserId).toBeNull();

    const wa = await CallModel.create(
      call({
        agentUserId: new Types.ObjectId(),
        whatsapp: {
          channelId: new Types.ObjectId(),
          waCallId: 'wacid.TEST1',
          direction: 'USER_INITIATED',
          timeline: [{ event: 'connect', at: new Date() }],
          metaErrors: [{ code: 138004 }],
        },
        billing: {
          whatsapp: {
            payer: 'platform',
            market: 'IN',
            perMinuteMicros: 388_500,
            status: 'free',
          },
        },
        endReason: 'no_agent_available',
      }),
    );
    expect(wa.whatsapp).toMatchObject({
      waCallId: 'wacid.TEST1',
      conversationId: null,
      ringUserIds: [],
      answeredBy: null,
      metaStatus: null,
    });
    expect(wa.billing.whatsapp).toMatchObject({ pulses: 0, metaCostMicros: 0, status: 'free' });

    for (const over of [
      { mode: 'robot' },
      { whatsapp: { channelId: new Types.ObjectId(), direction: 'SIDEWAYS' } },
      { whatsapp: { direction: 'USER_INITIATED' } },
      {
        billing: {
          whatsapp: { payer: 'nobody', market: 'IN', perMinuteMicros: 1, status: 'held' },
        },
      },
      {
        billing: { whatsapp: { payer: 'platform', market: 'IN', perMinuteMicros: 1, status: 'x' } },
      },
      { endReason: 'eaten' },
    ]) {
      await expect(CallModel.validate(call(over))).rejects.toThrow();
    }
  });

  it('a Meta call id is stored once', async () => {
    const whatsapp = {
      channelId: new Types.ObjectId(),
      waCallId: 'wacid.DUP',
      direction: 'BUSINESS_INITIATED',
    };
    await CallModel.create(call({ whatsapp }));
    await expect(CallModel.create(call({ whatsapp }))).rejects.toMatchObject({ code: 11000 });
    // calls without a Meta id (not dialled yet) don't collide
    const noId = { ...whatsapp, waCallId: null };
    await CallModel.create(call({ whatsapp: noId }));
    await CallModel.create(call({ whatsapp: noId }));
    const indexes = await CallModel.collection.indexes();
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'wa_call_id', unique: true }));
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'wa_channel_calls' }));
  });
});

describe('Message model — call bubbles and call interactive kinds', () => {
  const message = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    accountId: new Types.ObjectId(),
    conversationId: new Types.ObjectId(),
    channelId: new Types.ObjectId(),
    contactId: new Types.ObjectId(),
    direction: 'in',
    origin: 'system',
    type: 'call',
    status: 'received',
    at: new Date(),
    ...over,
  });

  it('one call bubble per call; outcomes and modes validate', async () => {
    const accountId = new Types.ObjectId();
    const callId = new Types.ObjectId();
    const call = { callId, direction: 'in', outcome: 'missed', durationSec: 0, mode: 'human' };
    const m = await MessageModel.create(message({ accountId, call }));
    expect(m.call).toMatchObject({ outcome: 'missed', mode: 'human' });
    await expect(MessageModel.create(message({ accountId, call }))).rejects.toMatchObject({
      code: 11000,
    });
    for (const bad of [
      { ...call, outcome: 'great' },
      { ...call, mode: 'robot' },
      { ...call, durationSec: -1 },
    ]) {
      await expect(MessageModel.validate(message({ call: bad }))).rejects.toThrow();
    }
    expect(await MessageModel.collection.indexes()).toContainEqual(
      expect.objectContaining({ name: 'call_bubble', unique: true }),
    );
  });

  it('call permission request / reply and voice call buttons', async () => {
    await expect(
      MessageModel.validate(
        message({
          type: 'interactive',
          interactive: {
            kind: 'call_permission_reply',
            callPermission: {
              response: 'accept',
              isPermanent: false,
              expiresAt: new Date(),
              source: 'user_action',
              requestWaMessageId: 'wamid.REQ',
            },
          },
        }),
      ),
    ).resolves.toBeDefined();
    await expect(
      MessageModel.validate(
        message({
          type: 'interactive',
          interactive: {
            kind: 'voice_call',
            body: 'Call us',
            voiceCall: { displayText: 'Call now', ttlMinutes: 60, payload: null },
          },
        }),
      ),
    ).resolves.toBeDefined();
    for (const interactive of [
      { kind: 'call_permission_reply', callPermission: { response: 'maybe' } },
      { kind: 'voice_call', voiceCall: { displayText: 'x'.repeat(21) } },
      { kind: 'voice_call', voiceCall: { displayText: 'Call', ttlMinutes: 43_201 } },
    ]) {
      await expect(
        MessageModel.validate(message({ type: 'interactive', interactive })),
      ).rejects.toThrow();
    }
  });
});

describe('Contact BSUID, user availability, account settings', () => {
  it('stores the BSUID with a partial index per account', async () => {
    const accountId = new Types.ObjectId();
    const c = await ContactModel.create({
      accountId,
      phoneE164: '+919000099130',
      source: { type: 'whatsapp' },
      whatsapp: { waId: '919000099130', bsuid: 'IN.1234567890' },
    });
    expect(c.whatsapp?.bsuid).toBe('IN.1234567890');
    const indexes = await ContactModel.collection.indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        name: 'whatsapp_bsuid',
        key: { accountId: 1, 'whatsapp.bsuid': 1 },
      }),
    );
  });

  it('users default to available; only the three states', async () => {
    const u = new UserModel({
      accountId: new Types.ObjectId(),
      name: 'Agent',
      email: 'agent-p12@example.com',
      roleId: new Types.ObjectId(),
      status: 'active',
    });
    expect(u.callAvailability).toBe('available');
    u.callAvailability = 'busy';
    await expect(u.validate()).resolves.toBeUndefined();
    u.set('callAvailability', 'away');
    await expect(u.validate()).rejects.toThrow();
  });

  it('accounts get WhatsApp call settings and an optional call price override', async () => {
    const a = new AccountModel({ name: 'A', slug: 'p12-model-a' });
    expect(a.settings.whatsappCalling).toEqual(DEFAULT_WHATSAPP_CALLING_SETTINGS);
    expect(a.whatsappCallingBilling).toBeNull();
    a.set('settings.whatsappCalling.maxCallMinutes', 61);
    await expect(a.validate()).rejects.toThrow();
    a.set('settings.whatsappCalling.maxCallMinutes', 60);
    a.set('whatsappCallingBilling', {
      markupBps: 1000,
      fixedPerMinuteMicros: null,
      platformFeePerMinuteMicros: 0,
    });
    await expect(a.validate()).resolves.toBeUndefined();
    a.set('whatsappCallingBilling.fixedPerMinuteMicros', -1);
    await expect(a.validate()).rejects.toThrow();
  });
});

describe('Rate cards — calling kind', () => {
  it('a calling card holds call rates only; messaging cards message rates only', async () => {
    const calling = await WhatsAppRateCardModel.create({
      kind: 'calling',
      effectiveFrom: new Date(),
      source: 'manual',
      callingMarkets: structuredClone(PLACEHOLDER_CALLING_MARKETS),
    });
    expect(calling.markets).toEqual([]);
    const messaging = await WhatsAppRateCardModel.create({
      effectiveFrom: new Date(),
      source: 'manual',
      markets: structuredClone(PLACEHOLDER_MARKETS),
    });
    expect(messaging.kind).toBe('messaging');
    expect(messaging.callingMarkets).toEqual([]);

    for (const card of [
      { kind: 'calling', callingMarkets: [] },
      {
        kind: 'calling',
        callingMarkets: structuredClone(PLACEHOLDER_CALLING_MARKETS),
        markets: structuredClone(PLACEHOLDER_MARKETS),
      },
      {
        kind: 'calling',
        callingMarkets: [{ ...PLACEHOLDER_CALLING_MARKETS[0], perMinuteMicros: 1.5 }],
      },
      {
        markets: structuredClone(PLACEHOLDER_MARKETS),
        callingMarkets: PLACEHOLDER_CALLING_MARKETS,
      },
      { kind: 'texting', markets: structuredClone(PLACEHOLDER_MARKETS) },
    ] as Record<string, unknown>[]) {
      await expect(
        WhatsAppRateCardModel.create({ effectiveFrom: new Date(), source: 'manual', ...card }),
      ).rejects.toThrow();
    }
    expect(await WhatsAppRateCardModel.collection.indexes()).toContainEqual(
      expect.objectContaining({ name: 'kind_effective_from' }),
    );
  });
});

describe('PlatformSettings — whatsappCalling', () => {
  it('validates the call settings per key, also on updateOne', async () => {
    await expect(
      PlatformSettingsModel.validate({
        key: 'whatsappCalling',
        value: {
          markupBps: 1500,
          platformFeePerMinuteMicros: 0,
          holdMinutes: 5,
          holdExtendMinutes: 5,
        },
      }),
    ).resolves.toBeDefined();
    for (const value of [
      { markupBps: 1500, platformFeePerMinuteMicros: 0, holdMinutes: 0, holdExtendMinutes: 5 },
      { markupBps: 1500, platformFeePerMinuteMicros: 0, holdMinutes: 5 },
      { markupBps: 1500, platformFeeMicros: 0, holdMaxAgeHours: 72 },
      { markupBps: 1.5, platformFeePerMinuteMicros: 0, holdMinutes: 5, holdExtendMinutes: 5 },
      {
        markupBps: 1500,
        platformFeePerMinuteMicros: 0,
        holdMinutes: 5,
        holdExtendMinutes: 5,
        extra: 1,
      },
      null,
    ]) {
      await expect(
        PlatformSettingsModel.validate({ key: 'whatsappCalling', value }),
      ).rejects.toThrow();
    }
    await PlatformSettingsModel.updateOne(
      { key: 'whatsappCalling' },
      {
        $set: {
          value: {
            markupBps: 1,
            platformFeePerMinuteMicros: 0,
            holdMinutes: 5,
            holdExtendMinutes: 5,
          },
        },
      },
      { upsert: true, runValidators: true },
    );
    await expect(
      PlatformSettingsModel.updateOne(
        { key: 'whatsappCalling' },
        { $set: { value: { markupBps: -1 } } },
        { runValidators: true },
      ),
    ).rejects.toThrow();
    expect(
      (await PlatformSettingsModel.findOne({ key: 'whatsappCalling' }).lean())?.value,
    ).toMatchObject({ markupBps: 1 });
  });
});
