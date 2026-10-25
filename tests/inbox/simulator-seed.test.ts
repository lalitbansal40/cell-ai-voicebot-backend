import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { SEED_INBOX_CUSTOMERS, seedInbox } from '../../scripts/seed-inbox';
import { SEED_WHATSAPP_NUMBER, seedWhatsApp } from '../../scripts/seed-whatsapp';
import { credit } from '../../src/core/billing/engine';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { sendMessage } from '../../src/modules/inbox/outbound.service';
import { processSend } from '../../src/modules/inbox/send.job';
import {
  isInboxSimulatorKind,
  runInboxSimulator,
  SIM_CUSTOMER,
} from '../../src/modules/inbox/simulator';
import { INBOX_SIMULATOR_KINDS } from '../../src/modules/inbox/simulator-kinds';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { ALL_SIMULATOR_KINDS } from '../../src/modules/whatsapp/whatsapp.schema';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Simulates through the dev route, then processes like the worker. */
const queued: string[] = [];
const waJobs = { enqueueEvent: (id: string) => (queued.push(id), Promise.resolve()) };
const sim = async (kind: string, extra: Record<string, unknown> = {}) => {
  const r = await runInboxSimulator(
    { ctx: world.w.ctx, jobs: waJobs, storage: world.storage },
    state.channel._id,
    kind as never,
    extra,
  );
  for (const id of queued.splice(0)) await processWebhookEvent(state.h, id, { finalAttempt: true });
  await world.runJobs();
  return r;
};
const sendRuns = async () => {
  for (const job of world.jobs.sent.splice(0))
    await processSend(state.ix, job.id, { finalAttempt: true, waits: 20 });
};

describe('inbox simulator — every kind through the real pipeline', () => {
  let users: Awaited<ReturnType<typeof world.setup>>['users'];
  beforeEach(async () => {
    ({ users } = await world.setup());
    queued.length = 0;
  });

  it('kind lists: 29 inbox kinds, 70 in total', () => {
    expect(INBOX_SIMULATOR_KINDS).toHaveLength(29);
    // 16 + 29 − 1 shared + 14 template / billing (Phase 11) + 12 calling (Phase 12)
    expect(ALL_SIMULATOR_KINDS).toHaveLength(70);
    expect(isInboxSimulatorKind('inbound_voice')).toBe(true);
    expect(isInboxSimulatorKind('quality_downgrade')).toBe(false);
  });

  it('customer messages of every type land in the chat (media downloaded)', async () => {
    const kinds = [
      ['inbound_text', 'text'],
      ['inbound_image', 'image'],
      ['inbound_video', 'video'],
      ['inbound_audio', 'audio'],
      ['inbound_voice', 'audio'],
      ['inbound_document', 'document'],
      ['inbound_sticker', 'sticker'],
      ['inbound_location', 'location'],
      ['inbound_contacts', 'contacts'],
      ['inbound_template_button', 'button'],
      ['inbound_forwarded', 'text'],
      ['inbound_ad_referral', 'text'],
      ['inbound_order', 'order'],
      ['inbound_nfm_reply', 'interactive'],
      ['inbound_unsupported', 'unsupported'],
      ['inbound_number_changed', 'system'],
    ] as const;
    for (const [kind] of kinds) expect((await sim(kind)).received, kind).toBe(1);
    const msgs = await world.messagesOf({ direction: 'in' });
    expect(msgs.map((m) => m.type)).toEqual(kinds.map(([, type]) => type));
    expect(msgs.filter((m) => m.media).every((m) => m.media?.status === 'ready')).toBe(true);
    expect(msgs.find((m) => m.media?.voice)).toBeDefined();
    expect(msgs[11]?.context?.referral?.headline).toBe('Test ad headline');
    expect(
      (await ConversationModel.findOne({ channelId: state.channel._id, waId: SIM_CUSTOMER }).lean())
        ?.unreadCount,
    ).toBe(15);
  });

  it('replies, reactions, button / list replies point at our last messages; statuses; deleted', async () => {
    await sim('inbound_text', { from: '+91 90000 66001', text: 'Hello' });
    const conv = (await ConversationModel.findOne({
      channelId: state.channel._id,
      waId: '919000066001',
    }).lean())!;
    const actor = { accountId: state.acc.account._id, userId: users.agent.user._id };
    await sendMessage(state.ix, actor, conv._id.toString(), {
      clientId: randomUUID(),
      type: 'buttons',
      body: 'Pay?',
      buttons: [{ id: 'pay', title: 'Pay now' }],
    });
    await sendMessage(state.ix, actor, conv._id.toString(), {
      clientId: randomUUID(),
      type: 'list',
      body: 'Plans',
      button: 'Open',
      sections: [{ rows: [{ id: 'p3', title: '3 EMIs' }] }],
    });
    await sendRuns();
    const opts = { conversationId: conv._id.toString() };
    await sim('inbound_button_reply', opts);
    await sim('inbound_list_reply', opts);
    await sim('inbound_reply', { ...opts, text: 'Quoted' });
    await sim('inbound_reaction', { ...opts, text: '❤️' });
    const msgs = await world.messagesOf({ conversationId: conv._id });
    const button = msgs.find((m) => m.interactive?.kind === 'button_reply');
    expect(button?.interactive?.reply).toMatchObject({ id: 'pay', title: 'Pay now' });
    expect(button?.context?.replyToMessageId).toBeDefined();
    expect(
      msgs.find((m) => m.interactive?.kind === 'list_reply')?.interactive?.reply,
    ).toMatchObject({ id: 'p3', title: '3 EMIs' });
    expect(msgs.find((m) => m.text === 'Quoted')?.context?.replyToMessageId).toBeDefined();
    const reacted = msgs.find((m) => m.reactions.length);
    expect(reacted?.reactions[0]).toMatchObject({ emoji: '❤️', by: 'customer' });
    await sim('status_failed', opts);
    expect(
      (await MessageModel.find({ conversationId: conv._id, status: 'failed' }).lean()).length,
    ).toBe(1);
    await sim('inbound_deleted', opts);
    expect(
      (await MessageModel.find({ conversationId: conv._id, status: 'deleted' }).lean()).length,
    ).toBe(1);
    // nothing to point at → still a valid event
    expect((await sim('inbound_reaction', { from: '+91 90000 66009' })).received).toBe(1);
    expect((await sim('status_failed', { from: '+91 90000 66009' })).received).toBe(1);
    expect((await sim('inbound_button_reply', { from: '+91 90000 66009' })).received).toBe(1);
    expect((await sim('inbound_list_reply', { from: '+91 90000 66009' })).received).toBe(1);
    expect((await sim('inbound_deleted', { from: '+91 90000 66010' })).received).toBe(1);
  });

  it('keywords, window expiry, ageing + retention', async () => {
    await sim('inbound_stop', { from: '+91 90000 66101' });
    expect(
      (
        await ContactModel.findOne({
          phoneE164: '+919000066101',
          accountId: state.acc.account._id,
        }).lean()
      )?.optedOutAt,
    ).toBeInstanceOf(Date);
    await sim('inbound_start', { from: '+91 90000 66101' });
    await sim('inbound_stop_hinglish', { from: '+91 90000 66102' });
    await sim('inbound_stop_hindi', { from: '+91 90000 66103' });
    expect(
      await ContactModel.countDocuments({
        accountId: state.acc.account._id,
        optedOutAt: { $ne: null },
        phoneE164: { $in: ['+919000066102', '+919000066103'] },
      }),
    ).toBe(2);
    const conv = (await ConversationModel.findOne({
      channelId: state.channel._id,
      waId: '919000066102',
    }).lean())!;
    expect(await sim('window_expired', { conversationId: conv._id.toString() })).toMatchObject({
      field: '',
      received: 0,
    });
    const expired = await ConversationModel.findById(conv._id).lean();
    expect(expired?.windowExpiresAt?.getTime()).toBeLessThan(Date.now());
    await sim('age_messages', { conversationId: conv._id.toString(), days: 100 });
    const aged = await MessageModel.find({ conversationId: conv._id }).lean();
    expect(aged.every((m) => m.at.getTime() < Date.now() - 99 * 86_400_000)).toBe(true);
    await sim('run_retention');
    expect(await MessageModel.countDocuments({ conversationId: conv._id })).toBe(0);
    await expect(sim('window_expired', { from: '+91 90000 66999' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(sim('age_messages', { from: '+91 90000 66999' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(sim('inbound_text', { conversationId: '0'.repeat(24) })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      runInboxSimulator({ ctx: world.w.ctx, jobs: waJobs }, state.acc.account._id, 'inbound_text'),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await runInboxSimulator(
        { ctx: world.w.ctx, jobs: waJobs },
        state.channel._id,
        'run_retention',
      ),
    ).toMatchObject({ received: 0 });
  });
});

describe('dev routes', () => {
  let users: Awaited<ReturnType<typeof world.setup>>['users'];
  beforeEach(async () => {
    ({ users } = await world.setup());
  });
  const app = (env: NodeJS.ProcessEnv = {}) =>
    buildTestApp(env, {
      whatsapp: {
        ctx: world.w.ctx,
        jobs: waJobs,
        inboxJobs: world.jobs,
        storage: world.storage,
      },
    });

  it('POST /dev/meta/webhooks: inbox kinds need inbox.reply, number kinds whatsapp.manage', async () => {
    const target = app();
    const post = (t: string, body: Record<string, unknown>) =>
      request(target)
        .post('/api/v1/dev/meta/webhooks')
        .set(bearer(t))
        .send({ channelId: state.channel._id.toString(), ...body });
    expect(
      (
        await post(users.agent.token, {
          kind: 'inbound_image',
          from: '+91 90000 67001',
          text: 'Hi',
        })
      ).body.data,
    ).toMatchObject({
      kind: 'inbound_image',
      field: 'messages',
      received: 1,
    });
    expect((await post(users.viewer.token, { kind: 'inbound_text' })).status).toBe(403);
    expect((await post(users.agent.token, { kind: 'quality_downgrade' })).status).toBe(403);
    expect((await post(users.owner.token, { kind: 'quality_downgrade' })).body.data).toMatchObject({
      field: 'phone_number_quality_update',
    });
    expect((await post(users.agent.token, { kind: 'inbound_text', from: 'abc' })).status).toBe(422);
    expect((await post(users.agent.token, { kind: 'nope' })).status).toBe(422);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect((await post(stranger.token, { kind: 'inbound_text' })).status).toBe(404);
  });

  it('GET /dev/meta/media/:id serves fake media with a valid signature + Bearer; /dev/meta/sent lists sends', async () => {
    const target = app();
    const id = await world.w.fake.putMedia(Buffer.from('%PDF-1.4 test'), 'application/pdf');
    const { url } = await world.w.fake.getMediaUrl(state.token, id, state.channel.phoneNumberId!);
    const path = new URL(url).pathname + new URL(url).search;
    const got = await request(target).get(path).set('Authorization', 'Bearer fake_tok_x');
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toContain('application/pdf');
    expect(got.body.toString()).toContain('%PDF');
    expect((await request(target).get(path)).status).toBe(403);
    expect(
      (
        await request(target)
          .get(path.replace(/sig=[0-9a-f]+/, 'sig=00'))
          .set('Authorization', 'Bearer x')
      ).status,
    ).toBe(403);
    await world.w.fake.deleteMedia(id);
    expect((await request(target).get(path).set('Authorization', 'Bearer x')).status).toBe(404);

    const sent = await request(target)
      .get(`/api/v1/dev/meta/sent?channelId=${state.channel._id.toString()}`)
      .set(bearer(users.viewer.token));
    expect(sent.body.data).toEqual({ sent: [], readReceipts: [] });
    expect(
      (
        await request(target)
          .get('/api/v1/dev/meta/sent?channelId=x')
          .set(bearer(users.viewer.token))
      ).status,
    ).toBe(422);
    expect(
      (await request(target).get(`/api/v1/dev/meta/sent?channelId=${state.channel._id.toString()}`))
        .status,
    ).toBe(401);
  });

  it('not mounted without MOCK_APIS_ENABLED', async () => {
    const off = app({ MOCK_APIS_ENABLED: 'false' });
    expect(
      (await request(off).post('/api/v1/dev/meta/webhooks').set(bearer(users.owner.token)).send({}))
        .status,
    ).toBe(404);
    expect((await request(off).get('/api/v1/dev/meta/media/x')).status).toBe(404);
  });
});

describe('seedInbox', () => {
  it('demo chats through the real pipeline — once', async () => {
    await WhatsAppChannelModel.deleteMany({ displayPhoneNumber: SEED_WHATSAPP_NUMBER });
    const t = await createTestAccount({ name: 'Demo Finance' });
    const owner = await t.addUser('owner');
    const logger = createLogger(world.w.env);
    const deps = {
      env: world.w.env,
      ownerId: owner.user._id,
      redis: world.w.redis,
      logger,
      storage: world.storage,
    };
    expect(await seedInbox(t.account._id, deps)).toMatchObject({
      skipped: 'No demo WhatsApp number',
    });
    await seedWhatsApp(t.account._id, deps);
    // like `db:seed` (billing runs before the inbox): the demo replies are charged
    await credit({
      accountId: t.account._id,
      type: 'topup',
      amountMicros: 1_000 * 1_000_000,
      ref: { type: 'manual', id: 'seed-test' },
      idempotencyKey: `seed-test-${t.account._id.toString()}`,
    });
    const first = await seedInbox(t.account._id, deps);
    expect(first.skipped).toBeNull();
    expect(first.conversations).toBeGreaterThanOrEqual(5);
    const channel = await WhatsAppChannelModel.findOne({ accountId: t.account._id }).lean();
    const conv = (waId: string) =>
      ConversationModel.findOne({ channelId: channel?._id, waId: waId.replace(/\D/g, '') }).lean();
    const text = await conv(SEED_INBOX_CUSTOMERS.text);
    const reply = await MessageModel.findOne({
      conversationId: text?._id,
      direction: 'out',
      origin: 'agent',
    }).lean();
    expect(reply?.status).toBe('read');
    const media = await MessageModel.find({
      conversationId: (await conv(SEED_INBOX_CUSTOMERS.media))?._id,
    }).lean();
    expect(media.map((m) => m.media?.status)).toEqual(['ready', 'ready', 'ready']);
    expect((await conv(SEED_INBOX_CUSTOMERS.closed))?.status).toBe('closed');
    expect(
      await MessageModel.exists({ channelId: channel?._id, origin: 'business_app' }),
    ).toBeTruthy();
    expect(
      (
        await ContactModel.findOne({
          accountId: t.account._id,
          phoneE164: SEED_INBOX_CUSTOMERS.stop.replace(/\s/g, ''),
        }).lean()
      )?.optedOutAt,
    ).toBeInstanceOf(Date);
    // the seed's deferred Phase 9 inbound text was backfilled
    expect(
      await ConversationModel.exists({ channelId: channel?._id, waId: '919000010101' }),
    ).toBeTruthy();
    expect(await seedInbox(t.account._id, deps)).toEqual({
      conversations: 0,
      messages: 0,
      skipped: null,
    });
    expect(
      await seedInbox(t.account._id, { ...deps, env: { ...deps.env, WHATSAPP_ENABLED: false } }),
    ).toMatchObject({ skipped: expect.any(String) as string });
  });
});
