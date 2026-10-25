import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { setRealtime } from '../../src/core/realtime';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel, type ContactDoc } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel, type MessageDoc } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppCallPermissionModel } from '../../src/db/models/whatsapp-call-permission.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { getContactPanel } from '../../src/modules/inbox/conversations.service';
import { toMessageView } from '../../src/modules/inbox/inbox-json';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import { processSend } from '../../src/modules/inbox/send.job';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createCallPermissionTemplate } from '../../src/modules/templates/template.service';
import { createCallPermissions } from '../../src/modules/whatsapp-calling/permissions.service';
import { createCallingSettings } from '../../src/modules/whatsapp-calling/settings.service';
import {
  createCallingHooks,
  createInboxCallingHook,
} from '../../src/modules/whatsapp-calling/webhooks';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { customerText, useInboxWorld } from '../helpers/inbox';
import { userActor } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const events: { type: string; data: Record<string, unknown> }[] = [];
let permissions: ReturnType<typeof createCallPermissions>;

beforeAll(() => {
  const token = (id: Types.ObjectId | string) => world.w.svc.getChannelToken(id);
  const settings = createCallingSettings({ ctx: world.w.ctx, token });
  permissions = createCallPermissions({ ctx: world.w.ctx, token, inbox: state.ix });
  state.h.calling = createCallingHooks({ settings });
  state.ix.calling = createInboxCallingHook(permissions);
  // the fake's reply webhooks go through the real receiver + handlers
  world.w.fake.setWebhookEmitter(async (body) => {
    await world.deliver(body);
  });
});
beforeEach(() => {
  events.length = 0;
  setRealtime({
    pushToAccount: (_t: string, type: string, data: Record<string, unknown>) => {
      events.push({ type, data });
      return Promise.resolve();
    },
    pushToUser: () => Promise.resolve(),
    pushToTopic: () => Promise.resolve(),
  } as never);
});
afterEach(() => setRealtime(undefined));

const customer = (knob: string) => `91900007${knob}`;

/** The customer writes (window open) → contact + conversation. */
const writes = async (waId: string) => {
  await world.deliver(
    customerText(state.channel, { from: waId, at: Math.floor(Date.now() / 1000) }),
  );
  const contact = await ContactModel.findOne({
    accountId: state.acc.account._id,
    phoneE164: `+${waId}`,
  }).lean<ContactDoc>();
  if (!contact) throw new Error('no contact');
  return contact;
};

/** A contact we never talked to (window closed). */
const silent = (waId: string) =>
  ContactModel.create({
    accountId: state.acc.account._id,
    phoneE164: `+${waId}`,
    source: { type: 'manual' },
  });

const runSends = async () => {
  for (const job of world.jobs.sent.splice(0)) {
    if (job.name !== INBOX_JOBS.messageSend) continue;
    await processSend(state.ix, job.id, { finalAttempt: true, waits: 0 });
  }
};

const enableCalling = () =>
  WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    { $set: { 'calling.status': 'enabled' } },
  );

describe('call permissions', () => {
  let users: Awaited<ReturnType<typeof world.setup>>['users'];
  let actor: {
    type: 'user';
    id: Types.ObjectId;
    accountId: Types.ObjectId;
    userId: Types.ObjectId;
  };
  beforeEach(async () => {
    ({ users } = await world.setup());
    await enableCalling();
    actor = {
      type: 'user',
      id: users.agent.user._id,
      accountId: state.acc.account._id,
      userId: users.agent.user._id,
    };
  });

  it('in the window: interactive request → customer accepts (temporary) → panel, bubbles, WS, bell, audit', async () => {
    const contact = await writes(customer('00023'));
    const panel0 = await permissions.statusFor(actor.accountId, state.channel._id, contact._id);
    expect(panel0).toMatchObject({
      status: 'none',
      canCall: false,
      canRequest: true,
      reason: 'no_permission',
    });
    const res = await permissions.request(actor, {
      channelId: state.channel._id.toString(),
      contactId: contact._id.toString(),
    });
    expect(res.kind).toBe('interactive');
    const request = await MessageModel.findById(res.messageId).lean<MessageDoc>();
    expect(request?.interactive).toMatchObject({
      kind: 'call_permission_request',
      body: expect.stringContaining('WhatsApp par call') as string,
    });
    expect(request?.billing).not.toBeNull();
    // waiting for the answer: the panel says why there is no new request
    expect(
      await permissions.statusFor(actor.accountId, state.channel._id, contact._id),
    ).toMatchObject({ status: 'requested', canRequest: false, reason: 'requested' });
    await runSends();
    await vi.waitFor(async () =>
      expect(
        (await permissions.loadRow(actor.accountId, state.channel._id, contact._id))?.status,
      ).toBe('temporary'),
    );
    const row = await permissions.loadRow(actor.accountId, state.channel._id, contact._id);
    expect(row).toMatchObject({ source: 'request_reply', unansweredStreak: 0 });
    expect(row?.lastRequest).toMatchObject({ kind: 'interactive' });
    expect((row?.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect(row?.history.map((h) => h.status)).toEqual(['requested', 'temporary']);
    // the request bubble shows it was answered (written right after the row); the reply
    // bubble carries the answer
    await vi.waitFor(async () => {
      const answered = await MessageModel.findById(res.messageId).lean<MessageDoc>();
      expect(toMessageView(answered!).interactive).toMatchObject({
        requestState: 'answered',
        callPermission: { response: 'accept', isPermanent: false },
      });
    });
    const reply = await MessageModel.findOne({
      'interactive.kind': 'call_permission_reply',
      contactId: contact._id,
    }).lean<MessageDoc>();
    expect(toMessageView(reply!).interactive).toMatchObject({
      kind: 'call_permission_reply',
      requestState: null,
      callPermission: { response: 'accept', source: 'user_action' },
    });
    const panel = await permissions.statusFor(actor.accountId, state.channel._id, contact._id, {
      refresh: true,
    });
    expect(panel).toMatchObject({
      status: 'temporary',
      canCall: true,
      canRequest: false,
      reason: null,
    });
    // the inbox contact panel uses the same state
    const conv = await ConversationModel.findOne({ contactId: contact._id }).lean();
    const inboxPanel = await getContactPanel(
      state.ix,
      { ...actor, ip: null },
      conv!._id.toString(),
    );
    expect(inboxPanel.callPermission).toMatchObject({ status: 'temporary', canCall: true });
    const ws = events
      .filter((e) => e.type === 'whatsapp.call_permission.updated')
      .map((e) => e.data.status);
    expect(ws).toEqual(expect.arrayContaining(['requested', 'temporary']));
    expect(JSON.stringify(events)).not.toContain(customer('00023'));
    const bell = await NotificationModel.findOne({
      type: 'whatsapp.call_permission_granted',
    }).lean();
    expect(bell?.userId.toString()).toBe(users.agent.user._id.toString());
    expect(bell?.link).toBe(`/inbox/${conv!._id.toString()}`);
    expect(bell?.body).not.toContain('Test Customer');
    for (const action of [
      'whatsapp.call_permission_requested',
      'whatsapp.call_permission_granted',
    ]) {
      const a = await AuditLogModel.findOne({ action }).lean();
      expect(a, action).toBeTruthy();
      expect(JSON.stringify(a)).not.toContain(customer('00023'));
    }
    // already allowed
    await expect(
      permissions.request(actor, {
        channelId: state.channel._id.toString(),
        contactId: contact._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CALL_PERMISSION_EXISTS' });
  });

  it('permanent / declined replies; our counters (1 / day) and Meta’s limits; nextRequestAt', async () => {
    const perm = await writes(customer('00024'));
    await permissions.request(actor, {
      channelId: state.channel._id.toString(),
      contactId: perm._id.toString(),
    });
    await runSends();
    await vi.waitFor(async () =>
      expect(
        (await permissions.loadRow(actor.accountId, state.channel._id, perm._id))?.status,
      ).toBe('permanent'),
    );
    const declines = await writes(customer('00025'));
    const input = { channelId: state.channel._id.toString(), contactId: declines._id.toString() };
    await permissions.request(actor, input);
    await runSends();
    await vi.waitFor(async () =>
      expect(
        (await permissions.loadRow(actor.accountId, state.channel._id, declines._id))?.status,
      ).toBe('declined'),
    );
    // the bell is written right after the row (same handler)
    await vi.waitFor(async () =>
      expect(
        await NotificationModel.exists({ type: 'whatsapp.call_permission_declined' }),
      ).toBeTruthy(),
    );
    // a second request the same day → 429 with the next allowed time
    const err = (await permissions.request(actor, input).catch((e: unknown) => e)) as {
      code: string;
      details: { message: string }[];
      retryAfterSec?: number;
    };
    expect(err.code).toBe('WHATSAPP_CALL_PERMISSION_LIMIT');
    expect(Date.parse(err.details[0]?.message ?? '')).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    const panel = await permissions.statusFor(actor.accountId, state.channel._id, declines._id);
    expect(panel).toMatchObject({
      status: 'declined',
      canRequest: false,
      canCall: false,
      reason: 'declined',
    });
    expect(panel.nextRequestAt).not.toBeNull();
    // Meta's own counter refuses even when ours would allow (request sent from another app)
    const other = await writes(customer('00057'));
    await world.w.fake.sendMessage(state.token, state.channel.phoneNumberId ?? '', {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: customer('00057'),
      type: 'interactive',
      interactive: { type: 'call_permission_request', action: { name: 'call_permission_request' } },
    });
    await expect(
      permissions.request(actor, {
        channelId: state.channel._id.toString(),
        contactId: other._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CALL_PERMISSION_LIMIT' });
  });

  it('outside the window: the approved call permission template, or a clear error without one', async () => {
    const contact = await silent(customer('00058'));
    const input = { channelId: state.channel._id.toString(), contactId: contact._id.toString() };
    await expect(permissions.request(actor, input)).rejects.toMatchObject({
      code: 'WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING',
    });
    // nothing was counted for the refused request
    expect(
      (await permissions.loadRow(actor.accountId, state.channel._id, contact._id))?.requests ?? {
        day: [],
      },
    ).toMatchObject({ day: [] });
    const created = await createCallPermissionTemplate(
      { wa: world.w.ctx, jobs: recordingTemplateJobs() },
      state.acc.account._id,
      userActor(),
      { channelId: state.channel._id.toString(), submit: true },
    );
    await WhatsAppTemplateModel.updateOne({ _id: created.id }, { $set: { status: 'APPROVED' } });
    const res = await permissions.request(actor, input);
    expect(res.kind).toBe('template');
    const m = await MessageModel.findById(res.messageId).lean<MessageDoc>();
    expect(m?.type).toBe('template');
  });

  it('refuses DND, opted-out and blocked customers and numbers that cannot call', async () => {
    const contact = await writes(customer('00059'));
    const input = { channelId: state.channel._id.toString(), contactId: contact._id.toString() };
    const refuse = async (set: Record<string, unknown>, reason: string) => {
      await ContactModel.updateOne({ _id: contact._id }, { $set: set });
      await expect(permissions.request(actor, input)).rejects.toMatchObject({
        code: 'CALL_NOT_ALLOWED',
        details: [{ path: 'contactId', message: reason }],
      });
      expect(
        (await permissions.statusFor(actor.accountId, state.channel._id, contact._id)).reason,
      ).toBe(reason);
      await ContactModel.updateOne(
        { _id: contact._id },
        { $set: { dnd: false, optedOutAt: null, 'whatsapp.blocked': false } },
      );
    };
    await refuse({ dnd: true }, 'dnd');
    await refuse({ optedOutAt: new Date() }, 'opted_out');
    await refuse({ 'whatsapp.blocked': true }, 'blocked');
    await ConversationModel.updateOne({ contactId: contact._id }, { $set: { blocked: true } });
    await expect(permissions.request(actor, input)).rejects.toMatchObject({
      code: 'CALL_NOT_ALLOWED',
    });
    await ConversationModel.updateOne({ contactId: contact._id }, { $set: { blocked: false } });
    for (const [set, code] of [
      [{ 'calling.status': 'disabled' }, 'WHATSAPP_CALLING_DISABLED'],
      [{ 'calling.status': 'unavailable' }, 'WHATSAPP_CALLING_UNAVAILABLE'],
      [
        {
          'calling.status': 'enabled',
          'calling.restrictions': [
            {
              type: 'RESTRICTED_BUSINESS_INITIATED_CALLING',
              reason: null,
              expiresAt: new Date(Date.now() + 3_600_000),
            },
          ],
        },
        'WHATSAPP_CALLING_RESTRICTED',
      ],
    ] as const) {
      await WhatsAppChannelModel.updateOne({ _id: state.channel._id }, { $set: set });
      await expect(permissions.request(actor, input), code).rejects.toMatchObject({ code });
    }
    await expect(
      permissions.request(actor, { ...input, contactId: new Types.ObjectId().toString() }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });

  it('a Meta API error never lets a request through (permission check failed)', async () => {
    const contact = await writes(customer('00060'));
    world.w.fake.failNext('getCallPermissions');
    await expect(
      permissions.request(actor, {
        channelId: state.channel._id.toString(),
        contactId: contact._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'WHATSAPP_CALL_PERMISSION_CHECK_FAILED' });
    world.w.fake.failNext('getCallPermissions');
    expect(
      await permissions.statusFor(actor.accountId, state.channel._id, contact._id, {
        refresh: true,
      }),
    ).toMatchObject({ canCall: false, canRequest: false, reason: 'check_failed' });
  });

  it('automatic callback permission (the customer called) and the expiry sweep', async () => {
    const contact = await writes(customer('00061'));
    await permissions.onReply({
      channel: state.channel,
      contactId: contact._id,
      reply: {
        response: 'accept',
        isPermanent: false,
        expiresAt: new Date(Date.now() + 60_000),
        source: 'automatic',
      },
      contextId: 'wacid.MISSED',
      at: new Date(),
    });
    const row = await permissions.loadRow(actor.accountId, state.channel._id, contact._id);
    expect(row).toMatchObject({ status: 'temporary', source: 'callback' });
    // past its time: the sweep marks it expired (Meta sends no webhook)
    await WhatsAppCallPermissionModel.updateOne(
      { _id: row!._id },
      { $set: { expiresAt: new Date(Date.now() - 1_000) } },
    );
    expect(await permissions.sweep()).toEqual({ expired: 1 });
    expect(await permissions.sweep()).toEqual({ expired: 0 });
    const after = await permissions.loadRow(actor.accountId, state.channel._id, contact._id);
    expect(after?.status).toBe('expired');
    expect(after?.history.at(-1)).toMatchObject({ status: 'expired', source: 'sweep' });
    expect(
      events.some(
        (e) => e.type === 'whatsapp.call_permission.updated' && e.data.status === 'expired',
      ),
    ).toBe(true);
    // an expired row reads as expired before the sweep too
    await WhatsAppCallPermissionModel.updateOne(
      { _id: row!._id },
      { $set: { status: 'temporary' } },
    );
    expect(
      (await permissions.statusFor(actor.accountId, state.channel._id, contact._id)).status,
    ).toBe('expired');
  });

  it('Meta decides: our row says allowed, WhatsApp has no permission → revoked, cannot call', async () => {
    const contact = await writes(customer('00030'));
    await WhatsAppCallPermissionModel.create({
      accountId: actor.accountId,
      channelId: state.channel._id,
      contactId: contact._id,
      status: 'permanent',
    });
    const panel = await permissions.statusFor(actor.accountId, state.channel._id, contact._id, {
      refresh: true,
    });
    expect(panel).toMatchObject({
      status: 'revoked',
      expiresAt: null,
      canCall: false,
      canRequest: true,
      reason: 'no_permission',
    });
  });

  it('unanswered streak: 2 → nudge, 4 → revoked (bell to the requester + managers); an answer resets it', async () => {
    const contact = await writes(customer('00062'));
    await WhatsAppCallPermissionModel.create({
      accountId: actor.accountId,
      channelId: state.channel._id,
      contactId: contact._id,
      status: 'permanent',
      lastRequest: {
        messageId: new Types.ObjectId(),
        kind: 'interactive',
        at: new Date(),
        by: users.agent.user._id,
      },
    });
    const outcome = (answered: boolean) =>
      permissions.onCallOutcome({
        accountId: actor.accountId,
        channelId: state.channel._id,
        contactId: contact._id,
        answered,
      });
    expect(await outcome(false)).toBe('ok');
    expect(await outcome(false)).toBe('nudge');
    expect(await outcome(true)).toBe('ok');
    expect(
      (await permissions.loadRow(actor.accountId, state.channel._id, contact._id))
        ?.unansweredStreak,
    ).toBe(0);
    for (const expected of ['ok', 'nudge', 'nudge', 'revoked'] as const)
      expect(await outcome(false)).toBe(expected);
    const row = await permissions.loadRow(actor.accountId, state.channel._id, contact._id);
    expect(row?.status).toBe('revoked');
    const bells = await NotificationModel.find({ type: 'whatsapp.call_permission_revoked' }).lean();
    expect(bells.map((b) => b.userId.toString())).toEqual(
      expect.arrayContaining([users.agent.user._id.toString(), users.manager.user._id.toString()]),
    );
    expect(await AuditLogModel.exists({ action: 'whatsapp.call_permission_revoked' })).toBeTruthy();
  });

  it('an old WhatsApp (131026) fails the request bubble with a clear reason', async () => {
    const old = await writes(customer('00026'));
    const res = await permissions.request(actor, {
      channelId: state.channel._id.toString(),
      contactId: old._id.toString(),
    });
    // the fake's auto statuses are off in tests: deliver the failed status like Meta
    await world.deliver({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: state.channel.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '1',
                  phone_number_id: state.channel.phoneNumberId,
                },
                statuses: [
                  {
                    id: await (async () => {
                      await runSends();
                      return (
                        (await MessageModel.findById(res.messageId).lean<MessageDoc>())
                          ?.waMessageId ?? ''
                      );
                    })(),
                    status: 'failed',
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: customer('00026'),
                    errors: [{ code: 131026, title: 'Message undeliverable' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const m = await MessageModel.findById(res.messageId).lean<MessageDoc>();
    expect(m?.error?.reason).toBe("Customer's WhatsApp is too old");
    expect(toMessageView(m!).interactive?.requestState).toBe('failed');
  });
});
