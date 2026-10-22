import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it } from 'vitest';

import { signWebhook } from '../../src/core/meta';
import { processWhatsAppJob } from '../../src/core/queues/workers/whatsapp.worker';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import {
  hasDeferredInboxEvents,
  INBOX_FIELDS,
  runInboxBackfill,
} from '../../src/modules/inbox/backfill.job';
import { importHistoryEvent, retentionCutoff } from '../../src/modules/inbox/coexistence-import';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import { sealSecret } from '../../src/modules/whatsapp/context';
import { deferredConsumers } from '../../src/modules/whatsapp/deferred-events';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../../src/modules/whatsapp/webhooks.service';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { customerText, firstMessage, uniqueWamid, useInboxWorld, valueOf } from '../helpers/inbox';
import { webhookFor } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const now = () => String(Math.floor(Date.now() / 1000));

const echo = (edit?: (m: Record<string, unknown>) => void) =>
  world.fixture('webhook-smb-message-echoes.json', (p) => {
    const m = (valueOf(p).message_echoes as Record<string, unknown>[])[0]!;
    m.id = uniqueWamid();
    m.timestamp = now();
    edit?.(m);
  });

describe('coexistence — echoes (Sent from the WhatsApp Business app)', () => {
  beforeEach(async () => {
    await world.setup({ mode: 'coexistence' });
  });

  it('becomes an outgoing business_app message (sent), no unread, no window, contact + conversation', async () => {
    expect(await echo()).toEqual(['processed']);
    const conv = await ConversationModel.findOne({
      accountId: state.acc.account._id,
      waId: '919000000101',
    }).lean();
    expect(conv).toMatchObject({
      source: 'business_app',
      unreadCount: 0,
      lastInboundAt: null,
      windowExpiresAt: null,
    });
    const [msg] = await world.messagesOf();
    expect(msg).toMatchObject({
      direction: 'out',
      origin: 'business_app',
      status: 'sent',
      type: 'text',
      text: 'Test reply sent from the business phone',
    });
    expect(msg?.statusHistory.map((s) => s.status)).toEqual(['sent']);
    expect(conv?.lastMessage).toMatchObject({
      direction: 'out',
      preview: 'Test reply sent from the business phone',
    });
    expect(
      await ContactModel.countDocuments({
        accountId: state.acc.account._id,
        phoneE164: '+919000000101',
      }),
    ).toBe(1);
    // Phase 9 coexistence counter still kept
    expect(
      (await WhatsAppChannelModel.findById(state.channel._id).lean())?.coexistence.echoesAt,
    ).toBeInstanceOf(Date);
  });

  it('duplicates once; echo media is downloaded; an echoed reaction lands on its target; echoes without a customer are skipped', async () => {
    const id = uniqueWamid();
    await echo((m) => (m.id = id));
    await echo((m) => (m.id = id));
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(1);
    const mediaId = await world.w.fake.putMedia(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]),
      'image/jpeg',
    );
    await echo((m) => {
      m.type = 'image';
      delete m.text;
      m.image = { id: mediaId, mime_type: 'image/jpeg' };
    });
    expect(world.jobs.sent.map((j) => j.name)).toEqual([INBOX_JOBS.mediaDownload]);
    await echo((m) => {
      m.type = 'reaction';
      delete m.text;
      m.reaction = { message_id: id, emoji: '🙏' };
    });
    const target = await MessageModel.findOne({ waMessageId: id }).lean();
    expect(target?.reactions).toEqual([expect.objectContaining({ emoji: '🙏', by: 'agent' })]);
    await echo((m) => delete m.to);
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(3);
  });

  it('a malformed echo value fails the event', async () => {
    expect(
      await world.fixture('webhook-smb-message-echoes.json', (p) => {
        valueOf(p).message_echoes = [];
      }),
    ).toEqual(['failed']);
  });
});

describe('coexistence — history import', () => {
  beforeEach(async () => {
    await world.setup({ mode: 'coexistence' });
  });

  const history = (
    edit?: (chunk: Record<string, unknown>) => void,
    fixture = 'webhook-history-chunk.json',
  ) =>
    world.fixture(fixture, (p) => {
      const chunk = (valueOf(p).history as Record<string, unknown>[])[0]!;
      const threads = (chunk.threads ?? []) as { messages: Record<string, unknown>[] }[];
      for (const t of threads) for (const m of t.messages) m.timestamp = now();
      edit?.(chunk);
    });

  it('a chunk is imported by its job: conversations, messages (statuses), no unread, event consumed', async () => {
    expect(
      await history((chunk) => {
        const thread = (chunk.threads as { id: string; messages: Record<string, unknown>[] }[])[0]!;
        thread.messages.push({
          from: '919000000010',
          id: uniqueWamid(),
          timestamp: now(),
          type: 'text',
          text: { body: 'Test old reply' },
          history_context: { status: 'DELIVERED' },
        });
      }),
    ).toEqual(['deferred']);
    const job = world.jobs.sent.find((j) => j.name === INBOX_JOBS.historyImport);
    expect(job).toBeDefined();
    const [result] = await world.runJobs();
    expect(result).toEqual({ conversations: 1, messages: 2, duplicates: 0, skippedOld: 0 });
    const msgs = await world.messagesOf();
    expect(msgs.map((m) => [m.direction, m.origin, m.status])).toEqual([
      ['in', 'history', 'received'],
      ['out', 'history', 'delivered'],
    ]);
    const conv = await ConversationModel.findOne({ accountId: state.acc.account._id }).lean();
    expect(conv).toMatchObject({ source: 'history', unreadCount: 0, windowExpiresAt: null });
    expect(conv?.lastMessage?.preview).toBe('Test old reply');
    expect((await MetaWebhookEventModel.findById(job?.id).lean())?.status).toBe('processed');
    // the same event again (job redelivered) → nothing
    expect(await importHistoryEvent(state.ix, job!.id)).toBeNull();
  });

  it('skips messages older than the retention cutoff; dedupes; the final chunk audits the totals', async () => {
    const old = String(Math.floor(Date.now() / 1000) - 100 * 86_400);
    const keep = uniqueWamid();
    await history((chunk) => {
      const thread = (chunk.threads as { messages: Record<string, unknown>[] }[])[0]!;
      thread.messages[0]!.timestamp = old;
      thread.messages.push({
        from: '919000000101',
        id: keep,
        timestamp: now(),
        type: 'text',
        text: { body: 'x' },
      });
    });
    await world.runJobs();
    await history((chunk) => {
      const thread = (chunk.threads as { messages: Record<string, unknown>[] }[])[0]!;
      thread.messages[0]!.id = keep;
      thread.messages[0]!.text = { body: 'changed' };
    });
    await world.runJobs();
    await history(undefined, 'webhook-history-final.json');
    await world.runJobs();
    const audit = await AuditLogModel.findOne({
      accountId: state.acc.account._id,
      action: 'inbox.history_imported',
    }).lean();
    expect(audit?.meta).toEqual({ conversations: 2, messages: 1, duplicates: 1, skippedOld: 1 });
    expect(retentionCutoff(state.ix)?.getTime()).toBeLessThan(Date.now() - 89 * 86_400_000);
  });

  it('declined history queues nothing; disconnected numbers and missing events are skipped', async () => {
    await world.fixture('webhook-history-declined.json');
    expect(world.jobs.sent).toEqual([]);
    expect(
      (await WhatsAppChannelModel.findById(state.channel._id).lean())?.coexistence.historySync,
    ).toBe('declined');
    await history();
    const job = world.jobs.sent.find((j) => j.name === INBOX_JOBS.historyImport)!;
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { status: 'disconnected' } },
    );
    expect(await importHistoryEvent(state.ix, job.id)).toBeNull();
    expect(await importHistoryEvent(state.ix, '000000000000000000000000')).toBeNull();
  });

  it('retention 0 imports everything; media within 7 days is downloaded; bad payloads throw', async () => {
    const ix0 = {
      ...state.ix,
      wa: { ...state.ix.wa, env: { ...state.ix.wa.env, INBOX_RETENTION_DAYS: 0 } },
    };
    expect(retentionCutoff(ix0)).toBeNull();
    const mediaId = await world.w.fake.putMedia(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      'image/jpeg',
    );
    await history((chunk) => {
      const thread = (chunk.threads as { messages: Record<string, unknown>[] }[])[0]!;
      thread.messages[0]!.timestamp = String(Math.floor(Date.now() / 1000) - 200 * 86_400);
      thread.messages.push({
        from: '919000000101',
        id: uniqueWamid(),
        timestamp: now(),
        type: 'image',
        image: { id: mediaId },
      });
    });
    const job = world.jobs.sent.splice(0).find((j) => j.name === INBOX_JOBS.historyImport)!;
    expect(await importHistoryEvent(ix0, job.id)).toMatchObject({ messages: 2, skippedOld: 0 });
    expect(world.jobs.sent.map((j) => j.name)).toEqual([INBOX_JOBS.mediaDownload]);
    await MetaWebhookEventModel.updateOne({ _id: job.id }, { $set: { status: 'deferred' } });
    await MetaWebhookEventModel.updateOne(
      { _id: job.id },
      { $set: { payloadSealed: sealSecret(world.w.ctx, JSON.stringify({ history: [] })) } },
    );
    await expect(importHistoryEvent(state.ix, job.id)).rejects.toMatchObject({
      name: 'WebhookSchemaError',
    });
  });
});

describe('coexistence — phone contacts sync', () => {
  beforeEach(async () => {
    await world.setup({ mode: 'coexistence' });
  });

  const sync = (items: Record<string, unknown>[]) =>
    world.fixture('webhook-smb-app-state-sync.json', (p) => {
      valueOf(p).state_sync = items;
    });

  it('add creates / names contacts (unless a person named them); remove only marks', async () => {
    expect(
      await sync([
        {
          type: 'contact',
          action: 'add',
          contact: { full_name: 'Phone Book Asha', phone_number: '+91 90000 00301' },
        },
        { type: 'contact', contact: { first_name: 'Ravi', phone_number: '919000000302' } },
        { type: 'contact', action: 'add', contact: { phone_number: '12' } },
        { type: 'label', action: 'add' },
      ]),
    ).toEqual(['processed']);
    const asha = await ContactModel.findOne({
      accountId: state.acc.account._id,
      phoneE164: '+919000000301',
    }).lean();
    expect(asha).toMatchObject({ name: 'Phone Book Asha', source: { type: 'whatsapp' } });
    expect(
      (
        await ContactModel.findOne({
          accountId: state.acc.account._id,
          phoneE164: '+919000000302',
        }).lean()
      )?.name,
    ).toBe('Ravi');
    await ContactModel.updateOne(
      { _id: asha?._id },
      { $set: { name: 'Asha K', 'whatsapp.nameEditedAt': new Date() } },
    );
    await sync([
      {
        type: 'contact',
        action: 'add',
        contact: { full_name: 'Renamed In Phone', phone_number: '919000000301' },
      },
      { type: 'contact', action: 'remove', contact: { phone_number: '919000000302' } },
      { type: 'contact', action: 'remove', contact: { phone_number: '919000000399' } },
    ]);
    expect((await ContactModel.findById(asha?._id).lean())?.name).toBe('Asha K');
    const ravi = await ContactModel.findOne({
      accountId: state.acc.account._id,
      phoneE164: '+919000000302',
    }).lean();
    expect(ravi?.whatsapp?.syncRemovedAt).toBeInstanceOf(Date);
    expect(ravi?.deletedAt).toBeNull();
    // added back → mark cleared
    await sync([
      {
        type: 'contact',
        action: 'add',
        contact: { full_name: 'Ravi', phone_number: '919000000302' },
      },
    ]);
    expect((await ContactModel.findById(ravi?._id).lean())?.whatsapp?.syncRemovedAt).toBeNull();
    expect(
      (await WhatsAppChannelModel.findById(state.channel._id).lean())?.coexistence.contactsSync,
    ).toBe('received');
  });

  it('a malformed state sync fails the event', async () => {
    expect(await sync([])).toEqual(['failed']);
  });
});

describe('backfill of events stored before Phase 10', () => {
  beforeEach(async () => {
    // events left deferred by the tests above belong to other accounts' numbers
    await MetaWebhookEventModel.deleteMany({ status: 'deferred' });
    await world.setup({ mode: 'coexistence' });
  });

  /** Stores + processes a payload like the Phase 9 worker (no inbox hooks) → deferred. */
  const phase9 = async (payload: Record<string, unknown>) => {
    const ids: string[] = [];
    const raw = Buffer.from(JSON.stringify(payload));
    await receiveWebhook(
      world.w.ctx,
      { enqueueEvent: (id) => (ids.push(id), Promise.resolve()) },
      raw,
      signWebhook(raw, world.w.env.FAKE_META_APP_SECRET ?? ''),
    );
    for (const id of ids) {
      await processWebhookEvent({ ctx: world.w.ctx, service: world.w.svc }, id, {
        finalAttempt: false,
      });
    }
    return ids;
  };

  it('registers the consumed fields and processes every deferred event once (rerun: no duplicates)', async () => {
    expect(deferredConsumers()).toEqual(expect.arrayContaining([...INBOX_FIELDS]));
    const text = customerText(state.channel, { text: 'Before Phase 10' });
    const [textId] = await phase9(text);
    const echoPayload = webhookFor('webhook-smb-message-echoes.json', state.channel);
    (valueOf(echoPayload).message_echoes as Record<string, unknown>[])[0]!.timestamp = now();
    await phase9(echoPayload);
    const syncPayload = webhookFor('webhook-smb-app-state-sync.json', state.channel);
    await phase9(syncPayload);
    const historyPayload = webhookFor('webhook-history-chunk.json', state.channel);
    const thread = (
      (valueOf(historyPayload).history as Record<string, unknown>[])[0]!.threads as {
        messages: Record<string, unknown>[];
      }[]
    )[0]!;
    thread.messages[0]!.timestamp = now();
    const [historyId] = await phase9(historyPayload);
    expect((await MetaWebhookEventModel.findById(textId).lean())?.status).toBe('deferred');
    expect(await hasDeferredInboxEvents()).toBe(true);

    const result = await runInboxBackfill(state.ix);
    expect(result).toMatchObject({ processed: 3, queued: 1, failed: 0 });
    expect(world.jobs.sent).toContainEqual({ name: INBOX_JOBS.historyImport, id: historyId });
    await world.runJobs();
    expect((await MetaWebhookEventModel.findById(textId).lean())?.status).toBe('processed');
    const texts = (await world.messagesOf()).map((m) => m.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Before Phase 10',
        'Test reply sent from the business phone',
        'Test old message',
      ]),
    );
    const count = await MessageModel.countDocuments({ accountId: state.acc.account._id });
    // processed events are not deferred any more → a rerun does nothing
    expect(await runInboxBackfill(state.ix)).toMatchObject({ processed: 0, queued: 0 });
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(count);
    expect(firstMessage(text).id).toBeDefined();
  });

  it('events of disconnected numbers stay deferred; unparseable ones are marked failed', async () => {
    const [a] = await phase9(customerText(state.channel));
    const bad = customerText(state.channel);
    const [b] = await phase9(bad);
    await MetaWebhookEventModel.updateOne(
      { _id: b },
      { $set: { payloadSealed: sealSecret(world.w.ctx, JSON.stringify({ nope: 1 })) } },
    );
    expect(await runInboxBackfill(state.ix)).toMatchObject({ processed: 1, failed: 1 });
    expect((await MetaWebhookEventModel.findById(b).lean())?.status).toBe('failed');
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { status: 'disconnected' } },
    );
    await MetaWebhookEventModel.updateOne({ _id: a }, { $set: { status: 'deferred' } });
    expect(await runInboxBackfill(state.ix)).toMatchObject({ skipped: 1 });
    expect((await MetaWebhookEventModel.findById(a).lean())?.status).toBe('deferred');
  });
});

describe('whatsapp worker — inbox jobs', () => {
  beforeEach(async () => {
    await world.setup();
  });

  const job = (name: string, data: Record<string, unknown>) =>
    ({ name, data, attemptsMade: 0, opts: { attempts: 2 } }) as unknown as Job;

  it('routes media downloads, backfill and history imports; unknown jobs throw; no inbox → throw', async () => {
    const h = { ctx: world.w.ctx, service: world.w.svc };
    const run = processWhatsAppJob(h, state.ix);
    await world.deliver(customerText(state.channel));
    expect(
      await run(job(INBOX_JOBS.mediaDownload, { messageId: '000000000000000000000000' })),
    ).toEqual({ status: 'skipped' });
    expect(await run(job(INBOX_JOBS.backfill, {}))).toMatchObject({ processed: 0 });
    expect(
      await run(job(INBOX_JOBS.historyImport, { eventId: '000000000000000000000000' })),
    ).toBeNull();
    await expect(run(job('nope', {}))).rejects.toThrow('Unknown whatsapp job "nope"');
    await expect(processWhatsAppJob(h)(job(INBOX_JOBS.backfill, {}))).rejects.toThrow(
      'Unknown whatsapp job',
    );
  });
});
