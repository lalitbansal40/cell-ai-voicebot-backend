import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { signWebhook, WEBHOOK_FIELDS } from '../../src/core/meta';
import {
  processMaintenanceJob,
  WHATSAPP_EVENTS_PURGE_JOB,
} from '../../src/core/queues/workers/maintenance.worker';
import { processWhatsAppJob } from '../../src/core/queues/workers/whatsapp.worker';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { NotificationModel, type NotificationType } from '../../src/db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import {
  deferredConsumers,
  listDeferred,
  markConsumed,
  registerDeferredField,
} from '../../src/modules/whatsapp/deferred-events';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import type { HandlerContext } from '../../src/modules/whatsapp/webhook-handlers';
import {
  processWebhookEvent,
  purgeWebhookEvents,
} from '../../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../../src/modules/whatsapp/webhooks.service';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import {
  codeFor,
  fakeSignup,
  idsFor,
  userActor,
  useWhatsAppWorld,
  webhookFor,
} from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const w = useWhatsAppWorld();

const queued: string[] = [];
const jobs: WhatsAppJobs = { enqueueEvent: (id) => (queued.push(id), Promise.resolve()) };
const h = (): HandlerContext => ({ ctx: w.ctx, service: w.svc });

let acc: TestAccount;
beforeEach(async () => {
  acc = await createTestAccount();
  await acc.addUser('owner');
  await acc.addUser('admin');
  queued.length = 0;
});

const connect = async (over = {}) => {
  const signup = fakeSignup(over);
  const r = await w.svc.connect({
    accountId: acc.account._id,
    actor: userActor(),
    mode: signup.mode,
    code: codeFor(signup),
  });
  return { id: r.channel.id, ids: idsFor(signup), view: r.channel };
};
const channelOf = (id: string) => WhatsAppChannelModel.findById(id).lean<WhatsAppChannelDoc>();

/** Signs + receives a payload, then processes every queued event. */
const deliver = async (payload: Record<string, unknown>) => {
  const raw = Buffer.from(JSON.stringify(payload));
  await receiveWebhook(w.ctx, jobs, raw, signWebhook(raw, w.env.FAKE_META_APP_SECRET ?? ''));
  const statuses = [];
  for (const id of queued.splice(0))
    statuses.push(await processWebhookEvent(h(), id, { finalAttempt: false }));
  return statuses;
};
const fixture = async (name: string, id: string, edit?: (p: Record<string, unknown>) => void) => {
  const c = await channelOf(id);
  const p = webhookFor(name, c!);
  edit?.(p);
  return deliver(p);
};
const valueOf = (p: Record<string, unknown>) =>
  (p.entry as { changes: { value: Record<string, unknown> }[] }[])[0]!.changes[0]!.value;
const notes = (type: NotificationType) =>
  NotificationModel.countDocuments({ accountId: acc.account._id, type });

describe('routing', () => {
  it('by phone number id → deferred messages kept 30 days; lastEventAt throttled', async () => {
    const { id } = await connect();
    expect(await fixture('webhook-messages-text.json', id)).toEqual(['deferred']);
    const event = await MetaWebhookEventModel.findOne({ field: 'messages', channelId: id }).lean();
    expect(event).toMatchObject({ status: 'deferred', accountId: acc.account._id, attempts: 1 });
    expect(event!.expiresAt.getTime() - event!.receivedAt.getTime()).toBe(30 * 86_400_000);
    const first = (await channelOf(id))?.webhook;
    expect(first).toMatchObject({ lastField: 'messages' });
    await fixture('webhook-messages-status.json', id);
    expect((await channelOf(id))?.webhook).toEqual(first);
  });

  it('by WABA id; unknown numbers / WABAs → ignored; no ids at all → ignored', async () => {
    const { id } = await connect();
    expect(await fixture('webhook-capability-update.json', id)).toEqual(['processed']);
    expect((await channelOf(id))?.capabilities).toMatchObject({
      max_phone_numbers_per_business: 2,
    });
    const stranger = { wabaId: '1', phoneNumberId: '2', displayPhoneNumber: '+91 90000 00000' };
    expect(await deliver(webhookFor('webhook-messages-text.json', stranger))).toEqual(['ignored']);
    expect(await deliver(webhookFor('webhook-account-update-ban.json', stranger))).toEqual([
      'ignored',
    ]);
    const blank = await MetaWebhookEventModel.create({
      key: new Types.ObjectId().toString(),
      object: 'whatsapp_business_account',
      field: 'x',
      wabaId: null,
      payloadSealed: 'x',
      receivedAt: new Date(),
      expiresAt: new Date(Date.now() + 1000),
    });
    expect(await processWebhookEvent(h(), blank._id.toString(), { finalAttempt: false })).toBe(
      'ignored',
    );
  });

  it("fields without a handler yet (Meta's Oct 2026 list) are kept as deferred events", async () => {
    const { id } = await connect();
    const channel = await channelOf(id);
    for (const field of ['account_review_update', 'account_alerts'] as const) {
      expect(WEBHOOK_FIELDS).toContain(field);
      const statuses = await deliver({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: channel!.wabaId,
            time: Math.floor(Date.now() / 1000),
            changes: [{ field, value: { decision: 'APPROVED' } }],
          },
        ],
      });
      expect(statuses).toEqual(['deferred']);
      expect(
        await MetaWebhookEventModel.exists({ field, channelId: id, status: 'deferred' }),
      ).toBeTruthy();
    }
  });

  it('finished events are skipped; unknown ids → null', async () => {
    const { id } = await connect();
    await fixture('webhook-capability-update.json', id);
    const event = await MetaWebhookEventModel.findOne({
      field: 'business_capability_update',
      channelId: id,
    });
    expect(await processWebhookEvent(h(), event!._id.toString(), { finalAttempt: false })).toBe(
      'processed',
    );
    expect((await MetaWebhookEventModel.findById(event!._id).lean())?.attempts).toBe(1);
    expect(
      await processWebhookEvent(h(), new Types.ObjectId().toString(), { finalAttempt: false }),
    ).toBeNull();
  });
});

describe('account_update', () => {
  it('restriction → restricted (+ until, notification); lifted → connected', async () => {
    const { id } = await connect();
    expect(await fixture('webhook-account-update-restriction.json', id)).toEqual(['processed']);
    const c = await channelOf(id);
    expect(c).toMatchObject({
      status: 'restricted',
      restriction: { type: 'RESTRICTED_ADD_PHONE_NUMBER_ACTION' },
      statusReason: { code: 'account_restriction' },
    });
    expect(c?.restriction?.until?.getTime()).toBe((1761120000 + 604800) * 1000);
    expect(await notes('whatsapp.channel_restricted')).toBe(2);
    await fixture('webhook-account-update-restriction.json', id, (p) => {
      valueOf(p).restriction_info = [];
    });
    expect(await channelOf(id)).toMatchObject({ status: 'connected', restriction: null });
  });

  it('ban → restricted; reinstated → lifted; violation; other number on the WABA unaffected', async () => {
    const { id } = await connect();
    await fixture('webhook-account-update-ban.json', id);
    expect(await channelOf(id)).toMatchObject({
      status: 'restricted',
      restriction: { type: 'SCHEDULE_FOR_DISABLE' },
    });
    await fixture('webhook-account-update-ban.json', id, (p) => {
      valueOf(p).ban_info = { waba_ban_state: ['REINSTATE'] };
    });
    expect((await channelOf(id))?.status).toBe('connected');
    await fixture('webhook-account-update-violation.json', id);
    expect(await channelOf(id)).toMatchObject({
      status: 'restricted',
      restriction: { type: 'SCAM' },
    });
    const other = await connect();
    await fixture('webhook-account-update-restriction.json', other.id, (p) => {
      valueOf(p).phone_number = '910000000000';
    });
    expect((await channelOf(other.id))?.status).toBe('connected');
  });

  it('partner removed → needs reconnect; verified → sync', async () => {
    const a = await connect();
    await fixture('webhook-account-update-partner-removed.json', a.id);
    expect(await channelOf(a.id)).toMatchObject({
      status: 'needs_reconnect',
      statusReason: { code: 'partner_removed' },
    });
    expect(await notes('whatsapp.channel_needs_reconnect')).toBe(2);
    const b = await connect();
    await w.fake.patchPhone(b.ids.phoneNumberId, { verified_name: 'Renamed Co' });
    await fixture('webhook-account-update-verified.json', b.id);
    expect((await channelOf(b.id))?.verifiedName).toBe('Renamed Co');
  });

  it('a failing sync after an event is logged, not fatal', async () => {
    const { id } = await connect();
    w.fake.failNext('debugToken', new Error('boom') as never);
    expect(await fixture('webhook-account-update-verified.json', id)).toEqual(['processed']);
  });
});

describe('quality / name / coexistence', () => {
  it('downgrade to red → tier + quality, one notification; flagged notifies', async () => {
    const { id, ids } = await connect();
    await w.fake.patchPhone(ids.phoneNumberId, {
      quality_rating: 'RED',
      messaging_limit_tier: 'TIER_250',
    });
    await fixture('webhook-quality-update.json', id);
    expect(await channelOf(id)).toMatchObject({
      qualityRating: 'RED',
      messagingLimitTier: 'TIER_250',
    });
    expect(await notes('whatsapp.quality_low')).toBe(2);
    await fixture('webhook-quality-update.json', id, (p) => {
      valueOf(p).old_limit = 'TIER_10K';
    });
    expect(await notes('whatsapp.quality_low')).toBe(2);
    await fixture('webhook-quality-flagged.json', id);
    expect(await notes('whatsapp.quality_low')).toBe(4);
    await fixture('webhook-quality-update.json', id, (p) => {
      valueOf(p).current_limit = 'TIER_WEIRD';
      valueOf(p).event = 'UPGRADE';
    });
    expect((await channelOf(id))?.messagingLimitTier).toBe('TIER_250');
  });

  it('name approved / rejected / deferred', async () => {
    const { id } = await connect();
    await fixture('webhook-name-update.json', id, (p) => {
      valueOf(p).requested_verified_name = 'Better Name';
    });
    expect(await channelOf(id)).toMatchObject({
      nameStatus: 'APPROVED',
      verifiedName: 'Better Name',
    });
    expect(await notes('whatsapp.name_approved')).toBe(2);
    await fixture('webhook-name-rejected.json', id);
    expect((await channelOf(id))?.newNameStatus).toBe('DECLINED');
    expect(await notes('whatsapp.name_rejected')).toBe(2);
    await fixture('webhook-name-update.json', id, (p) => {
      valueOf(p).decision = 'deferred';
    });
    expect((await channelOf(id))?.newNameStatus).toBe('DEFERRED');
  });

  it('echoes, history chunks / final / declined, contacts sync (stored deferred)', async () => {
    const { id } = await connect({ mode: 'coexistence' });
    expect(await fixture('webhook-smb-message-echoes.json', id)).toEqual(['deferred']);
    expect((await channelOf(id))?.coexistence.echoesAt).toBeInstanceOf(Date);
    await fixture('webhook-history-chunk.json', id);
    expect((await channelOf(id))?.coexistence).toMatchObject({
      historySync: 'requested',
      historyProgress: 55,
    });
    await fixture('webhook-history-final.json', id);
    expect((await channelOf(id))?.coexistence).toMatchObject({
      historySync: 'received',
      historyProgress: 100,
    });
    await fixture('webhook-history-declined.json', id);
    expect((await channelOf(id))?.coexistence.historySync).toBe('declined');
    await fixture('webhook-smb-app-state-sync.json', id);
    expect((await channelOf(id))?.coexistence.contactsSync).toBe('received');
    const deferred = await MetaWebhookEventModel.find({ channelId: id, status: 'deferred' }).lean();
    expect(deferred.map((e) => e.field).sort()).toEqual([
      'history',
      'history',
      'history',
      'smb_app_state_sync',
      'smb_message_echoes',
    ]);
  });
});

describe('failures', () => {
  it('schema mismatch → failed at once; other errors retry, then fail', async () => {
    const { id } = await connect();
    const bad = await fixture('webhook-quality-update.json', id, (p) => {
      delete valueOf(p).display_phone_number;
    });
    expect(bad).toEqual(['failed']);
    const failed = await MetaWebhookEventModel.findOne({
      channelId: null,
      status: 'failed',
      field: 'phone_number_quality_update',
    }).lean();
    expect(failed?.error).toBe('schema: unexpected phone_number_quality_update payload');

    const c = await channelOf(id);
    const raw = Buffer.from(JSON.stringify(webhookFor('webhook-name-update.json', c!)));
    await receiveWebhook(w.ctx, jobs, raw, signWebhook(raw, w.env.FAKE_META_APP_SECRET ?? ''));
    const eventId = queued.splice(0)[0]!;
    await MetaWebhookEventModel.updateOne(
      { _id: eventId },
      { $set: { payloadSealed: 'v1:broken' } },
    );
    await expect(processWebhookEvent(h(), eventId, { finalAttempt: false })).rejects.toThrow();
    expect(await MetaWebhookEventModel.findById(eventId).lean()).toMatchObject({
      status: 'received',
      attempts: 1,
      error: 'processing failed (SecretBoxError)',
    });
    expect(await processWebhookEvent(h(), eventId, { finalAttempt: true })).toBe('failed');
    expect((await MetaWebhookEventModel.findById(eventId).lean())?.attempts).toBe(2);
  });
});

describe('deferred API (Phases 10–12)', () => {
  it('lists pages oldest first, filters by channel, marks consumed', async () => {
    registerDeferredField('messages');
    registerDeferredField('calls');
    expect(deferredConsumers()).toEqual(expect.arrayContaining(['calls', 'messages']));
    const a = await connect();
    const b = await connect();
    await fixture('webhook-messages-text.json', a.id);
    await fixture('webhook-messages-status.json', a.id);
    await fixture('webhook-messages-text.json', b.id);
    const page1 = await listDeferred(w.ctx, { field: 'messages', channelId: a.id, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]?.value).toMatchObject({ messaging_product: 'whatsapp' });
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await listDeferred(w.ctx, {
      field: 'messages',
      channelId: new Types.ObjectId(a.id),
      cursor: page1.nextCursor,
    });
    expect(page2).toMatchObject({ nextCursor: null });
    expect(page2.items).toHaveLength(1);
    const all = await listDeferred(w.ctx, { field: 'messages', limit: 1000 });
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    expect(
      await markConsumed(
        w.ctx,
        page1.items.map((i) => i.id),
      ),
    ).toBe(1);
    expect(await markConsumed(w.ctx, [])).toBe(0);
    const consumed = await MetaWebhookEventModel.findById(page1.items[0]!.id).lean();
    expect(consumed).toMatchObject({ status: 'processed' });
    expect(consumed?.consumedAt).toBeInstanceOf(Date);
    expect((await listDeferred(w.ctx, { field: 'messages', channelId: a.id })).items).toHaveLength(
      1,
    );
  });
});

describe('jobs', () => {
  it('worker dispatch, purge job', async () => {
    const { id } = await connect();
    const c = await channelOf(id);
    const raw = Buffer.from(JSON.stringify(webhookFor('webhook-capability-update.json', c!)));
    await receiveWebhook(w.ctx, jobs, raw, signWebhook(raw, w.env.FAKE_META_APP_SECRET ?? ''));
    const run = processWhatsAppJob(h());
    const job = (name: string, attemptsMade = 0) =>
      ({
        name,
        data: { eventId: queued[0] },
        attemptsMade,
        opts: { attempts: 5 },
      }) as unknown as Job;
    expect(await run(job('webhook.process'))).toEqual({ status: 'processed' });
    await expect(run(job('nope'))).rejects.toThrow('Unknown whatsapp job');
    expect(
      await run({
        name: 'webhook.process',
        data: { eventId: queued[0] },
        attemptsMade: 0,
        opts: {},
      } as unknown as Job),
    ).toEqual({
      status: 'processed',
    });
    await MetaWebhookEventModel.updateOne(
      { _id: queued[0] },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await purgeWebhookEvents()).deleted).toBeGreaterThanOrEqual(1);
    const maintenance = processMaintenanceJob({ logger: createLogger(w.env) });
    expect(await maintenance({ name: WHATSAPP_EVENTS_PURGE_JOB } as Job)).toEqual({ deleted: 0 });
  });
});
