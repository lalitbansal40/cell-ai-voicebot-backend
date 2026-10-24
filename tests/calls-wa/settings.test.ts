import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { graphError } from '../../src/core/meta';
import { setRealtime } from '../../src/core/realtime';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  bicCountryBlocked,
  callingUnavailableReason,
} from '../../src/modules/whatsapp-calling/availability';
import {
  CallingSettingsPatch,
  isTimeZone,
} from '../../src/modules/whatsapp-calling/calling.schema';
import { createCallingSettings } from '../../src/modules/whatsapp-calling/settings.service';
import { createCallingHooks } from '../../src/modules/whatsapp-calling/webhooks';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { createAgentDoc } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

useTestDb();
const emails = useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const events: { type: string; data: unknown }[] = [];
let settings: ReturnType<typeof createCallingSettings>;

beforeAll(() => {
  settings = createCallingSettings({
    ctx: world.w.ctx,
    token: (id) => world.w.svc.getChannelToken(id),
  });
  state.h.calling = createCallingHooks({ settings });
});
beforeEach(() => {
  events.length = 0;
  emails.length = 0;
  setRealtime({
    pushToAccount: (_t: string, type: string, data: unknown) => {
      events.push({ type, data });
      return Promise.resolve();
    },
    pushToUser: () => Promise.resolve(),
    pushToTopic: () => Promise.resolve(),
  } as never);
});
afterEach(() => setRealtime(undefined));

const accountId = () => state.acc.account._id;
const channelId = () => state.channel._id.toString();
const actor = userActor();
const update = (patch: unknown) =>
  settings.updateCalling(actor, accountId(), channelId(), CallingSettingsPatch.parse(patch));
const metaCalling = () =>
  world.w.fake.getPhoneSettings(state.token, state.channel.phoneNumberId ?? '');
const future = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('WhatsApp calling settings', () => {
  let users: Awaited<ReturnType<typeof world.setup>>['users'];
  beforeEach(async () => {
    ({ users } = await world.setup());
  });

  it('defaults to off; enabling writes Meta first, stores, audits and tells the account', async () => {
    const before = await settings.getCalling(accountId(), channelId());
    expect(before).toMatchObject({
      status: 'disabled',
      unavailableReason: null,
      businessCallsAvailable: false,
      businessCallsBlockedBy: 'disabled',
      inbound: { route: 'team', ringTimeoutSec: 30, ringUserIds: null, aiProgram: null },
    });
    const view = await update({
      status: 'enabled',
      callIconVisibility: 'DEFAULT',
      iconCountries: ['in', 'IN'],
      callbackPermission: true,
      callHours: {
        enabled: true,
        timezone: 'Asia/Kolkata',
        weekly: [
          { day: 'MONDAY', open: '0900', close: '1300' },
          { day: 'MONDAY', open: '1400', close: '1800' },
        ],
        holidays: [{ date: future(10), start: '0000', end: '2359' }],
      },
      permissionRequestBody: 'Kya hum call kar sakte hain?',
      inbound: { ringTimeoutSec: 25, ringUserIds: [users.agent.user._id.toString()] },
    });
    expect(view).toMatchObject({
      status: 'enabled',
      businessCallsAvailable: true,
      iconCountries: ['IN'],
      callbackPermission: true,
      permissionRequestBody: 'Kya hum call kar sakte hain?',
      inbound: { ringTimeoutSec: 25, ringUserIds: [users.agent.user._id.toString()] },
    });
    const meta = await metaCalling();
    expect(meta).toMatchObject({
      status: 'ENABLED',
      iconCountries: ['IN'],
      callbackPermissionStatus: 'ENABLED',
      callHours: { status: 'ENABLED', timezoneId: 'Asia/Kolkata' },
    });
    expect(meta.callHours?.weekly).toHaveLength(2);
    const audit = await AuditLogModel.findOne({
      action: 'whatsapp.calling_settings_updated',
    }).lean<{
      meta: Record<string, unknown>;
    }>();
    expect(audit?.meta).toMatchObject({ callingStatus: 'enabled' });
    expect(audit?.meta.fields).toEqual(
      expect.arrayContaining([
        'status',
        'callHours',
        'inbound.ringUserIds',
        'inbound.ringTimeoutSec',
      ]),
    );
    expect(events.filter((e) => e.type === 'whatsapp.channel.updated').at(-1)?.data).toMatchObject({
      calling: { status: 'enabled', unavailableReason: null, restricted: false },
    });
    // our-only fields don't call Meta
    const calls = world.w.fake.calls.length;
    await update({ permissionRequestBody: 'Call?' });
    expect(world.w.fake.calls.slice(calls).map((c) => c.op)).not.toContain('updateCallingSettings');
    // turning off
    expect((await update({ status: 'disabled' })).status).toBe('disabled');
    expect((await metaCalling()).status).toBe('DISABLED');
  });

  it("refuses everything Meta refuses (table) and settings Meta doesn't know about", async () => {
    const hours = (over: Record<string, unknown>) => ({
      callHours: { enabled: true, timezone: 'Asia/Kolkata', weekly: [], holidays: [], ...over },
    });
    const schemaBad: unknown[] = [
      {},
      hours({ weekly: [{ day: 'MONDAY', open: '9:00', close: '1800' }] }),
      hours({ weekly: [{ day: 'MONDAY', open: '0900', close: '2400' }] }),
      hours({ timezone: 'Mars/Olympus' }),
      hours({ holidays: [{ date: '25-12-2026', start: '0000', end: '2359' }] }),
      hours({
        holidays: Array.from({ length: 21 }, (_, i) => ({
          date: future(i + 1),
          start: '0000',
          end: '2359',
        })),
      }),
      { iconCountries: ['IND'] },
      { inbound: { ringTimeoutSec: 31 } },
      { inbound: { ringTimeoutSec: 5 } },
      { inbound: { route: 'robots' } },
      { permissionRequestBody: '' },
      { permissionRequestBody: 'x'.repeat(1_025) },
      { status: 'unavailable' },
    ];
    for (const patch of schemaBad) {
      expect(
        CallingSettingsPatch.safeParse(patch).success,
        JSON.stringify(patch).slice(0, 80),
      ).toBe(false);
    }
    const serviceBad: [unknown, string][] = [
      [hours({ weekly: [{ day: 'MONDAY', open: '1800', close: '0900' }] }), 'callHours'],
      [
        hours({
          weekly: [
            { day: 'MONDAY', open: '0900', close: '1000' },
            { day: 'MONDAY', open: '1100', close: '1200' },
            { day: 'MONDAY', open: '1300', close: '1400' },
          ],
        }),
        'callHours',
      ],
      [
        hours({
          weekly: [
            { day: 'TUESDAY', open: '0900', close: '1300' },
            { day: 'TUESDAY', open: '1200', close: '1400' },
          ],
        }),
        'callHours',
      ],
      [hours({ weekly: [] }), 'callHours.weekly'],
      [
        hours({
          weekly: [{ day: 'FRIDAY', open: '0900', close: '1800' }],
          holidays: [{ date: '2020-01-01', start: '0000', end: '2359' }],
        }),
        'callHours.holidays.0.date',
      ],
      [{ inbound: { ringUserIds: [users.viewer.user._id.toString()] } }, 'inbound.ringUserIds.0'],
      [
        {
          inbound: {
            ringUserIds: [users.agent.user._id.toString(), users.agent.user._id.toString()],
          },
        },
        'inbound.ringUserIds',
      ],
      [{ inbound: { route: 'ai' } }, 'inbound.aiProgram'],
    ];
    for (const [patch, path] of serviceBad) {
      await expect(update(patch), JSON.stringify(patch).slice(0, 80)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: expect.arrayContaining([expect.objectContaining({ path })]) as unknown,
      });
    }
    expect(isTimeZone('Asia/Kolkata')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Not/AZone')).toBe(false);
  });

  it('AI routes need a runnable program (published flow / active agent)', async () => {
    const flow = await FlowModel.create({
      accountId: accountId(),
      name: 'Draft flow',
      draft: { nodes: [], edges: [] },
    } as never);
    await expect(
      update({ inbound: { route: 'ai', aiProgram: { kind: 'flow', id: flow._id.toString() } } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await FlowModel.updateOne(
      { _id: flow._id },
      { $set: { publishedVersionId: new Types.ObjectId(), publishedVersion: 1 } },
    );
    expect(
      (
        await update({
          inbound: { route: 'ai', aiProgram: { kind: 'flow', id: flow._id.toString() } },
        })
      ).inbound,
    ).toMatchObject({ route: 'ai', aiProgram: { kind: 'flow', id: flow._id.toString() } });
    const agentId = await createAgentDoc(accountId(), 'Off agent');
    await AiAgentModel.updateOne({ _id: agentId }, { $set: { isActive: false } });
    const agent = { _id: agentId };
    await expect(
      update({
        inbound: { route: 'ai_then_team', aiProgram: { kind: 'agent', id: agent._id.toString() } },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      update({ inbound: { aiProgram: { kind: 'agent', id: new Types.ObjectId().toString() } } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // back to the team clears nothing but needs no program
    expect((await update({ inbound: { route: 'team', aiProgram: null } })).inbound.route).toBe(
      'team',
    );
  });

  it('unavailable numbers: coexistence, low messaging limit, not Cloud API; BIC country rule', async () => {
    const c = state.channel;
    expect(callingUnavailableReason({ ...c, mode: 'coexistence' })).toBe('coexistence');
    expect(callingUnavailableReason({ ...c, isOnBizApp: true })).toBe('coexistence');
    expect(callingUnavailableReason({ ...c, messagingLimitTier: 'TIER_1K' })).toBe(
      'messaging_limit',
    );
    expect(callingUnavailableReason({ ...c, messagingLimitTier: 'TIER_2K' })).toBeNull();
    expect(callingUnavailableReason({ ...c, platformType: 'ON_PREMISE' })).toBe('not_cloud_api');
    expect(
      callingUnavailableReason({ ...c, messagingLimitTier: null, platformType: null }),
    ).toBeNull();
    for (const [phone, blocked] of [
      ['+14155550100', true],
      ['+201000000000', true],
      ['+84900000000', true],
      ['+2348000000000', true],
      ['+919000000010', false],
      ['+971500000000', false],
      [null, false],
    ] as const) {
      expect(bicCountryBlocked({ phoneE164: phone }), String(phone)).toBe(blocked);
    }
    await WhatsAppChannelModel.updateOne(
      { _id: c._id },
      { $set: { messagingLimitTier: 'TIER_250' } },
    );
    await expect(update({ status: 'enabled' })).rejects.toMatchObject({
      code: 'WHATSAPP_CALLING_UNAVAILABLE',
      details: [{ path: 'status', message: 'messaging_limit' }],
    });
    // other settings still save; the stored status says why
    const view = await update({ permissionRequestBody: 'Call?' });
    expect(view).toMatchObject({ unavailableReason: 'messaging_limit' });
    await WhatsAppChannelModel.updateOne(
      { _id: c._id },
      {
        $set: {
          messagingLimitTier: 'TIER_10K',
          phoneE164: '+14155550100',
          'calling.status': 'enabled',
        },
      },
    );
    expect(await settings.getCalling(accountId(), channelId())).toMatchObject({
      businessCallsAvailable: false,
      businessCallsBlockedBy: 'country',
    });
  });

  it('Meta errors are mapped and nothing is stored', async () => {
    world.w.fake.failNext(
      'updateCallingSettings',
      graphError(400, {
        error: { code: 138013, message: 'Calling unavailable', type: 'OAuthException' },
      }),
    );
    await expect(update({ status: 'enabled' })).rejects.toMatchObject({
      code: 'WHATSAPP_CALLING_UNAVAILABLE',
    });
    expect((await settings.getCalling(accountId(), channelId())).status).toBe('disabled');
    world.w.fake.failNext(
      'updateCallingSettings',
      graphError(400, {
        error: { code: 100, message: 'Invalid parameter', type: 'OAuthException' },
      }),
    );
    await expect(update({ status: 'enabled' })).rejects.toMatchObject({ code: 'META_API_ERROR' });
    await expect(
      settings.updateCalling(actor, new Types.ObjectId(), channelId(), { status: 'enabled' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('Meta → ours: manual sync, the daily sync and account_settings_update', async () => {
    const phone = state.channel.phoneNumberId ?? '';
    await world.w.fake.updateCallingSettings(state.token, phone, {
      status: 'ENABLED',
      callIconVisibility: 'DISABLE_ALL',
      iconCountries: ['AE'],
      callbackPermissionStatus: 'ENABLED',
      callHours: {
        status: 'ENABLED',
        timezoneId: 'Asia/Dubai',
        weekly: [{ day: 'SUNDAY', open: '1000', close: '1400' }],
        holidays: [],
      },
    });
    const synced = await settings.syncNow(accountId(), channelId());
    expect(synced).toMatchObject({
      status: 'enabled',
      callIconVisibility: 'DISABLE_ALL',
      iconCountries: ['AE'],
      callbackPermission: true,
      callHours: { enabled: true, timezone: 'Asia/Dubai', weekly: [{ day: 'SUNDAY' }] },
      lastError: null,
    });
    expect(synced.syncedAt).not.toBeNull();
    // Meta turned it off in WhatsApp Manager → the webhook makes us read again
    await world.w.fake.updateCallingSettings(state.token, phone, { status: 'DISABLED' });
    const statuses = await world.fixture('account-settings-update.json', (p) => {
      const value = (p as { entry: { changes: { value: Record<string, unknown> }[] }[] }).entry[0]
        ?.changes[0]?.value as { phone_number_settings: { calling: Record<string, unknown> } };
      value.phone_number_settings.calling.status = 'DISABLED';
    });
    expect(statuses).toEqual(['processed']);
    expect((await settings.getCalling(accountId(), channelId())).status).toBe('disabled');
    // the daily run covers every connected Cloud API number
    expect((await settings.syncAll()).synced).toBeGreaterThanOrEqual(1);
    // a failing read keeps our settings and notes the error (jobs never throw)
    world.w.fake.failNext('getPhoneSettings');
    const kept = await settings.syncCalling(state.channel);
    expect(kept).toBe(state.channel);
    expect((await settings.getCalling(accountId(), channelId())).lastError).toMatch(/WhatsApp/);
    world.w.fake.failNext('getPhoneSettings');
    await expect(settings.syncNow(accountId(), channelId())).rejects.toBeTruthy();
  });

  it('calling restrictions: stored on calling (not the number), bell + e-mail to owners / admins, audit', async () => {
    const statuses = await world.fixture('account-update-calling-restriction.json', (p) => {
      const value = (p as { entry: { changes: { value: Record<string, unknown> }[] }[] }).entry[0]
        ?.changes[0]?.value as {
        phone_number: string;
        restriction_info: { expiration: number }[];
      };
      value.phone_number = (state.channel.displayPhoneNumber ?? '').replace(/\D/g, '');
      // a 7-day pause from now (the fixture's date is in the past)
      for (const r of value.restriction_info)
        r.expiration = Math.floor(Date.now() / 1000) + 7 * 86_400;
    });
    expect(statuses).toEqual(['processed']);
    const channel = await WhatsAppChannelModel.findById(state.channel._id).lean();
    expect(channel?.status).toBe('connected');
    expect(channel?.calling?.restrictions).toEqual([
      expect.objectContaining({ type: 'RESTRICTED_BUSINESS_INITIATED_CALLING' }),
    ]);
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { 'calling.status': 'enabled' } },
    );
    expect(await settings.getCalling(accountId(), channelId())).toMatchObject({
      businessCallsAvailable: false,
      businessCallsBlockedBy: 'restricted',
      restrictions: [{ type: 'RESTRICTED_BUSINESS_INITIATED_CALLING', active: true }],
    });
    const bells = await NotificationModel.find({ type: 'whatsapp.calling_restricted' }).lean();
    const recipients = bells.map((b) => b.userId.toString()).sort();
    expect(recipients).toEqual(
      [users.owner.user._id.toString(), users.admin.user._id.toString()].sort(),
    );
    expect(bells[0]?.title).toBe('WhatsApp paused calling on a number');
    expect(bells[0]?.body).not.toMatch(/919000000101|Test Customer/);
    expect(emails.map((e) => e.template)).toEqual([
      'whatsapp.calling_restricted',
      'whatsapp.calling_restricted',
    ]);
    expect(await AuditLogModel.exists({ action: 'whatsapp.calling_restricted' })).toBeTruthy();
    // a warning only audits
    await world.fixture('account-update-calling-violation.json', (p) => {
      const value = (p as { entry: { changes: { value: Record<string, unknown> }[] }[] }).entry[0]
        ?.changes[0]?.value as { phone_number: string };
      value.phone_number = (state.channel.displayPhoneNumber ?? '').replace(/\D/g, '');
    });
    expect(await AuditLogModel.countDocuments({ action: 'whatsapp.calling_restricted' })).toBe(2);
    expect((await WhatsAppChannelModel.findById(state.channel._id).lean())?.status).toBe(
      'connected',
    );
  });
});
