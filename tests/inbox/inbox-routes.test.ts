import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { RoleModel } from '../../src/db/models/role.model';
import { authorizeTopic } from '../../src/modules/calls/topic-auth';
import { snippetOf } from '../../src/modules/inbox/conversations.service';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import { imageSize } from '../../src/modules/whatsapp/profile.service';
import { createTestAccount, tokenFor } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { customerText, firstMessage, mediaFixture, useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const base = '/api/v1/inbox';
const waJobs = { enqueueEvent: () => Promise.resolve() };
const app = (overrides: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}) =>
  buildTestApp(overrides, {
    whatsapp: {
      ctx: world.w.ctx,
      jobs: waJobs,
      inboxJobs: world.jobs,
      storage: world.storage,
      ...extra,
    },
  });

type Users = Awaited<ReturnType<typeof world.setup>>['users'];
let users: Users;
let convId: string;
const ROLES = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;

const setupWithChat = async (
  from = '919000030001',
  name = 'Asha Verma',
  text = 'Loan ki EMI kab hai',
) => {
  ({ users } = await world.setup());
  await world.deliver(customerText(state.channel, { from, name, text }));
  const c = await ConversationModel.findOne({
    accountId: state.acc.account._id,
    waId: from,
  }).lean();
  convId = c!._id.toString();
  world.jobs.sent.length = 0;
  return c!;
};
const send = (token: string, body: Record<string, unknown>, target = app()) =>
  request(target)
    .post(`${base}/conversations/${convId}/messages`)
    .set(bearer(token))
    .send({ clientId: randomUUID(), ...body });

describe('/inbox — roles', () => {
  beforeEach(async () => {
    await setupWithChat();
  });

  it('every role reads summary, list, detail, messages, contact panel and config', async () => {
    const target = app();
    for (const role of ROLES) {
      const t = users[role].token;
      expect((await request(target).get(`${base}/summary`).set(bearer(t))).body.data, role).toEqual(
        {
          unreadConversations: 1,
          assignedToMeUnread: 0,
          open: 1,
        },
      );
      const list = await request(target).get(`${base}/conversations`).set(bearer(t));
      expect(list.status, role).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        id: convId,
        label: 'Asha Verma',
        unreadCount: 1,
        windowOpen: true,
      });
      expect(list.body.meta).toEqual({ nextCursor: null });
      expect(
        (await request(target).get(`${base}/conversations/${convId}`).set(bearer(t))).body.data,
      ).toMatchObject({
        channel: { id: state.channel._id.toString(), status: 'connected' },
      });
      const msgs = await request(target)
        .get(`${base}/conversations/${convId}/messages`)
        .set(bearer(t));
      expect(msgs.body.data.map((m: { text: string }) => m.text)).toEqual(['Loan ki EMI kab hai']);
      expect(msgs.body.data[0]).not.toHaveProperty('waMessageId');
      expect(JSON.stringify(msgs.body)).not.toContain('storageKey');
      expect(
        (await request(target).get(`${base}/conversations/${convId}/contact`).set(bearer(t))).body
          .data,
      ).toMatchObject({
        contact: {
          name: 'Asha Verma',
          phoneE164: '+919000030001',
          whatsapp: { profileName: 'Asha Verma' },
        },
        callPermission: null,
        recentCalls: [],
      });
      expect((await request(target).get(`${base}/config`).set(bearer(t))).body.data).toMatchObject({
        retentionDays: 90,
        fakeProvider: true,
        limits: { textMax: 4096, buttonsMax: 3 },
      });
    }
    expect((await request(target).get(`${base}/summary`)).status).toBe(401);
  });

  it('send / note / close / reopen / typing: owner, admin, manager, agent — not viewers', async () => {
    const target = app();
    for (const role of ['owner', 'admin', 'manager', 'agent'] as const) {
      const r = await send(users[role].token, { type: 'text', text: `Hi from ${role}` }, target);
      expect(r.status, role).toBe(201);
      expect(r.body.data).toMatchObject({ type: 'text', status: 'queued', direction: 'out' });
      expect((await send(users[role].token, { type: 'note', text: 'n' }, target)).status).toBe(201);
    }
    expect((await send(users.viewer.token, { type: 'text', text: 'x' }, target)).status).toBe(403);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/close`)
          .set(bearer(users.viewer.token))
      ).status,
    ).toBe(403);
    const closed = await request(target)
      .post(`${base}/conversations/${convId}/close`)
      .set(bearer(users.agent.token));
    expect(closed.body.data).toMatchObject({ status: 'closed' });
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/close`)
          .set(bearer(users.agent.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/reopen`)
          .set(bearer(users.agent.token))
      ).body.data.status,
    ).toBe('open');
    expect(
      await AuditLogModel.countDocuments({
        accountId: state.acc.account._id,
        action: { $in: ['inbox.conversation_closed', 'inbox.conversation_reopened'] },
      }),
    ).toBe(2);
    const typing = await request(target)
      .post(`${base}/conversations/${convId}/typing`)
      .set(bearer(users.agent.token));
    expect(typing.body.data).toEqual({ sent: true });
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/typing`)
          .set(bearer(users.viewer.token))
      ).status,
    ).toBe(403);
  });

  it('assign: managers assign anyone; agents only themselves; the assignee gets a bell; unknown users 422', async () => {
    const target = app();
    const patch = (t: string, assignedTo: string | null) =>
      request(target).patch(`${base}/conversations/${convId}`).set(bearer(t)).send({ assignedTo });
    const agentId = users.agent.user._id.toString();
    expect((await patch(users.agent.token, users.manager.user._id.toString())).status).toBe(403);
    expect((await patch(users.viewer.token, users.viewer.user._id.toString())).status).toBe(403);
    expect((await patch(users.agent.token, agentId)).body.data.assignedTo).toMatchObject({
      id: agentId,
    });
    expect((await patch(users.agent.token, null)).body.data.assignedTo).toBeNull();
    const assigned = await patch(users.manager.token, agentId);
    expect(assigned.body.data.assignedTo.id).toBe(agentId);
    expect(
      await NotificationModel.findOne({
        userId: users.agent.user._id,
        type: 'inbox.conversation_assigned',
      }).lean(),
    ).toMatchObject({
      title: 'Conversation assigned to you',
      body: 'Asha Verma',
      link: `/inbox/${convId}`,
    });
    // the agent can drop their own, not someone else's
    await patch(users.manager.token, users.manager.user._id.toString());
    expect((await patch(users.agent.token, null)).status).toBe(403);
    expect((await patch(users.manager.token, '0'.repeat(24))).status).toBe(422);
    expect((await patch(users.manager.token, 'nope')).status).toBe(422);
    // same assignee → no new audit
    const audits = await AuditLogModel.countDocuments({
      action: 'inbox.conversation_assigned',
      accountId: state.acc.account._id,
    });
    await patch(users.manager.token, users.manager.user._id.toString());
    expect(
      await AuditLogModel.countDocuments({
        action: 'inbox.conversation_assigned',
        accountId: state.acc.account._id,
      }),
    ).toBe(audits);
    const mine = await request(target)
      .get(`${base}/conversations?filter=mine`)
      .set(bearer(users.manager.token));
    expect(mine.body.data).toHaveLength(1);
    expect(
      (await request(target).get(`${base}/summary`).set(bearer(users.manager.token))).body.data
        .assignedToMeUnread,
    ).toBe(1);
  });

  it('block / unblock (inbox.assign) through Meta; the 24 h rule error is clear', async () => {
    const target = app();
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/block`)
          .set(bearer(users.agent.token))
      ).status,
    ).toBe(403);
    const blocked = await request(target)
      .post(`${base}/conversations/${convId}/block`)
      .set(bearer(users.manager.token));
    expect(blocked.body.data).toMatchObject({ blocked: true });
    expect(await world.w.fake.isBlocked(state.channel.phoneNumberId!, '919000030001')).toBe(true);
    expect(
      (
        await ContactModel.findOne({
          phoneE164: '+919000030001',
          accountId: state.acc.account._id,
        }).lean()
      )?.whatsapp?.blocked,
    ).toBe(true);
    expect(
      (await send(users.agent.token, { type: 'text', text: 'x' }, target)).body.error.code,
    ).toBe('WHATSAPP_RECIPIENT_BLOCKED');
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/block`)
          .set(bearer(users.manager.token))
      ).status,
    ).toBe(200);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/unblock`)
          .set(bearer(users.manager.token))
      ).body.data.blocked,
    ).toBe(false);
    await setupWithChat('919000000005');
    const refused = await request(app())
      .post(`${base}/conversations/${convId}/block`)
      .set(bearer(users.owner.token));
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      'You can only block customers who messaged you in the last 24 hours',
    );
    world.w.fake.failNext('blockUsers');
    expect(
      (
        await request(app())
          .post(`${base}/conversations/${convId}/block`)
          .set(bearer(users.owner.token))
      ).status,
    ).toBe(502);
  });

  it('impersonators read only (no read marker change, no receipt); suspended accounts read only', async () => {
    const platform = await createTestAccount({
      isPlatform: true,
      slug: `p-inbox-${Date.now()}`,
      name: 'P',
    });
    const superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
    const imp = await tokenFor(users.owner.user, { imp: superadmin.user._id.toString() });
    const target = app();
    expect(
      (await request(target).get(`${base}/conversations/${convId}`).set(bearer(imp))).status,
    ).toBe(200);
    expect(
      (await request(target).post(`${base}/conversations/${convId}/read`).set(bearer(imp))).status,
    ).toBe(204);
    expect((await ConversationModel.findById(convId).lean())?.unreadCount).toBe(1);
    expect(world.jobs.sent).toEqual([]);
    const blocked = await send(imp, { type: 'text', text: 'x' }, target);
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect(
      (await request(target).post(`${base}/conversations/${convId}/unread`).set(bearer(imp)))
        .status,
    ).toBe(403);
    expect(
      (
        await request(target)
          .patch(`${base}/conversations/${convId}`)
          .set(bearer(imp))
          .send({ assignedTo: null })
      ).status,
    ).toBe(403);
    // a real read
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/read`)
          .set(bearer(users.viewer.token))
      ).status,
    ).toBe(204);
    expect((await ConversationModel.findById(convId).lean())?.unreadCount).toBe(0);
    expect(world.jobs.sent.map((j) => j.name)).toEqual([INBOX_JOBS.readReceipt]);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${convId}/unread`)
          .set(bearer(users.agent.token))
      ).status,
    ).toBe(204);
    expect((await ConversationModel.findById(convId).lean())?.unreadCount).toBe(1);
    await AccountModel.updateOne({ _id: state.acc.account._id }, { $set: { status: 'suspended' } });
    expect(
      (await request(target).get(`${base}/conversations`).set(bearer(users.owner.token))).status,
    ).toBe(200);
    expect((await send(users.owner.token, { type: 'text', text: 'x' }, target)).status).toBe(403);
  });
});

describe('/inbox — isolation, search, filters, paging', () => {
  beforeEach(async () => {
    await setupWithChat();
  });

  it("another account never sees this account's conversations or messages", async () => {
    const mine = { users, convId, channel: state.channel };
    const msg = (await world.messagesOf())[0]!;
    await setupWithChat('919000030002', 'Other Person', 'Other account text');
    const other = users.owner.token;
    const target = app();
    for (const [method, url] of [
      ['get', `${base}/conversations/${mine.convId}`],
      ['get', `${base}/conversations/${mine.convId}/messages`],
      ['get', `${base}/conversations/${mine.convId}/contact`],
      ['post', `${base}/conversations/${mine.convId}/read`],
      ['post', `${base}/conversations/${mine.convId}/close`],
      ['post', `${base}/conversations/${mine.convId}/typing`],
      ['get', `${base}/messages/${msg._id.toString()}/media`],
      ['post', `${base}/messages/${msg._id.toString()}/retry`],
    ] as const) {
      expect((await request(target)[method](url).set(bearer(other))).status, url).toBe(404);
    }
    expect(
      (
        await request(target)
          .post(`${base}/conversations/${mine.convId}/messages`)
          .set(bearer(other))
          .send({ clientId: randomUUID(), type: 'text', text: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(target)
          .patch(`${base}/conversations/${mine.convId}`)
          .set(bearer(other))
          .send({ assignedTo: null })
      ).status,
    ).toBe(404);
    const list = await request(target).get(`${base}/conversations?q=Asha`).set(bearer(other));
    expect(list.body.data).toEqual([]);
    expect(
      (await request(target).get(`${base}/conversations`).set(bearer(other))).body.data.map(
        (c: { id: string }) => c.id,
      ),
    ).toEqual([convId]);
    expect(
      (await request(target).get(`${base}/conversations?q=EMI`).set(bearer(other))).body.data,
    ).toEqual([]);
  });

  it('search by name, number digits and message text (Hinglish, not stemmed) with a snippet', async () => {
    const target = app();
    const t = users.agent.token;
    const q = async (text: string) =>
      (
        await request(target)
          .get(`${base}/conversations?q=${encodeURIComponent(text)}`)
          .set(bearer(t))
      ).body.data as {
        id: string;
        match: { snippet: string } | null;
      }[];
    expect((await q('asha')).map((c) => c.id)).toEqual([convId]);
    expect((await q('30001')).map((c) => c.id)).toEqual([convId]);
    const byText = await q('kab');
    expect(byText.map((c) => c.id)).toEqual([convId]);
    expect(byText[0]?.match?.snippet).toContain('kab hai');
    expect(await q('nothing-like-this')).toEqual([]);
    expect((await request(target).get(`${base}/conversations?q=a`).set(bearer(t))).status).toBe(
      422,
    );
    expect(snippetOf(`${'x '.repeat(60)}needle here${' y'.repeat(60)}`, 'needle')).toMatch(
      /^…x .*needle here.*…$/,
    );
    expect(snippetOf('short', 'zzz')).toBe('short');
  });

  it('filters (unread, unassigned, closed, channel) and a stable cursor', async () => {
    for (let i = 0; i < 4; i += 1) {
      await world.deliver(
        customerText(state.channel, {
          from: `91900003100${String(i)}`,
          name: `C${String(i)}`,
          at: Math.floor(Date.now() / 1000) + i,
        }),
      );
    }
    const target = app();
    const t = users.owner.token;
    const page1 = await request(target).get(`${base}/conversations?limit=2`).set(bearer(t));
    expect(page1.body.data).toHaveLength(2);
    const cursor = page1.body.meta.nextCursor as string;
    // a new message between pages doesn't repeat rows
    await world.deliver(
      customerText(state.channel, {
        from: '919000031009',
        at: Math.floor(Date.now() / 1000) + 100,
      }),
    );
    const page2 = await request(target)
      .get(`${base}/conversations?limit=2&cursor=${cursor}`)
      .set(bearer(t));
    const page3 = await request(target)
      .get(`${base}/conversations?limit=2&cursor=${page2.body.meta.nextCursor as string}`)
      .set(bearer(t));
    const ids = [...page1.body.data, ...page2.body.data, ...page3.body.data].map(
      (c: { id: string }) => c.id,
    );
    expect(new Set(ids).size).toBe(5);
    expect(page3.body.meta.nextCursor).toBeNull();
    expect(
      (await request(target).get(`${base}/conversations?cursor=garbage`).set(bearer(t))).status,
    ).toBe(422);
    await ConversationModel.updateOne({ _id: convId }, { $set: { unreadCount: 0 } });
    expect(
      (await request(target).get(`${base}/conversations?filter=unread`).set(bearer(t))).body.data,
    ).toHaveLength(5);
    expect(
      (await request(target).get(`${base}/conversations?filter=unassigned`).set(bearer(t))).body
        .data,
    ).toHaveLength(6);
    await request(target).post(`${base}/conversations/${convId}/close`).set(bearer(t));
    expect(
      (
        await request(target).get(`${base}/conversations?status=closed`).set(bearer(t))
      ).body.data.map((c: { id: string }) => c.id),
    ).toEqual([convId]);
    expect(
      (
        await request(target)
          .get(`${base}/conversations?channelId=${'0'.repeat(24)}`)
          .set(bearer(t))
      ).body.data,
    ).toEqual([]);
    // conversations without messages (started) sort last and page by id
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: '+919000032000',
      source: { type: 'manual' },
    });
    await request(target)
      .post(`${base}/conversations/start`)
      .set(bearer(t))
      .send({ channelId: state.channel._id.toString(), contactId: contact._id.toString() });
    const all = await request(target).get(`${base}/conversations?limit=50`).set(bearer(t));
    expect(all.body.data.at(-1).lastMessage).toBeNull();
    const empty = Buffer.from(`|${(all.body.data.at(-1) as { id: string }).id}`).toString(
      'base64url',
    );
    expect(
      (await request(target).get(`${base}/conversations?cursor=${empty}`).set(bearer(t))).body.data,
    ).toEqual([]);
  });

  it('messages: older pages, jump around a message, reply quotes and sender names', async () => {
    const t = users.agent.token;
    const target = app();
    const sentIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      sentIds.push(
        (await send(t, { type: 'note', text: `Note ${String(i)}` }, target)).body.data.id as string,
      );
    }
    const first = (await world.messagesOf({ direction: 'in' }))[0]!;
    await MessageModel.updateOne(
      { _id: sentIds[5] },
      {
        $set: {
          context: {
            replyToWaMessageId: first.waMessageId,
            replyToMessageId: first._id,
            forwarded: false,
            frequentlyForwarded: false,
            referral: null,
          },
        },
      },
    );
    const page = await request(target)
      .get(`${base}/conversations/${convId}/messages?limit=3`)
      .set(bearer(t));
    expect(page.body.data.map((m: { text: string }) => m.text)).toEqual([
      'Note 3',
      'Note 4',
      'Note 5',
    ]);
    expect(page.body.data[2].replyTo).toMatchObject({
      id: first._id.toString(),
      preview: 'Loan ki EMI kab hai',
    });
    expect(page.body.data[0].sentBy).toMatchObject({ id: users.agent.user._id.toString() });
    expect(page.body.data[0].sentBy.name).not.toBe('');
    const older = await request(target)
      .get(
        `${base}/conversations/${convId}/messages?limit=3&before=${page.body.meta.olderCursor as string}`,
      )
      .set(bearer(t));
    expect(older.body.data.map((m: { text: string }) => m.text)).toEqual([
      'Note 0',
      'Note 1',
      'Note 2',
    ]);
    const oldest = await request(target)
      .get(
        `${base}/conversations/${convId}/messages?limit=3&before=${older.body.meta.olderCursor as string}`,
      )
      .set(bearer(t));
    expect(oldest.body.data.map((m: { text: string }) => m.text)).toEqual(['Loan ki EMI kab hai']);
    expect(oldest.body.meta.olderCursor).toBeNull();
    const around = await request(target)
      .get(`${base}/conversations/${convId}/messages?around=${sentIds[2]!}&limit=4`)
      .set(bearer(t));
    expect(around.body.data.map((m: { text: string }) => m.text)).toEqual([
      'Note 0',
      'Note 1',
      'Note 2',
      'Note 3',
      'Note 4',
    ]);
    expect(around.body.meta).toEqual({ olderCursor: expect.any(String) as string, hasNewer: true });
    expect(
      (
        await request(target)
          .get(`${base}/conversations/${convId}/messages?around=${'0'.repeat(24)}`)
          .set(bearer(t))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(target)
          .get(`${base}/conversations/${convId}/messages?before=bad`)
          .set(bearer(t))
      ).status,
    ).toBe(422);
    expect(
      (
        await request(target)
          .get(`${base}/conversations/${convId}/messages?before=x&around=${sentIds[0]!}`)
          .set(bearer(t))
      ).status,
    ).toBe(422);
  });
});

describe('/inbox — start chat, uploads, media, retries', () => {
  beforeEach(async () => {
    await setupWithChat();
  });

  it('start: new conversation (201) with a closed window → send 409, notes OK; existing → 200', async () => {
    const target = app();
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: '+919000033000',
      name: 'New Lead',
      source: { type: 'manual' },
    });
    const body = { channelId: state.channel._id.toString(), contactId: contact._id.toString() };
    const started = await request(target)
      .post(`${base}/conversations/start`)
      .set(bearer(users.agent.token))
      .send(body);
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({
      created: true,
      windowOpen: false,
      source: 'outbound',
      label: 'New Lead',
    });
    convId = started.body.data.id as string;
    const blocked = await send(users.agent.token, { type: 'text', text: 'Hi' }, target);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('WHATSAPP_WINDOW_CLOSED');
    expect(
      (await send(users.agent.token, { type: 'note', text: 'Called, no answer' }, target)).status,
    ).toBe(201);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/start`)
          .set(bearer(users.agent.token))
          .send(body)
      ).status,
    ).toBe(200);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/start`)
          .set(bearer(users.viewer.token))
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/start`)
          .set(bearer(users.agent.token))
          .send({ ...body, contactId: '0'.repeat(24) })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(target)
          .post(`${base}/conversations/start`)
          .set(bearer(users.agent.token))
          .send({ ...body, channelId: '0'.repeat(24) })
      ).status,
    ).toBe(404);
  });

  it('upload → send an image; idempotent resend 200; validation and size errors', async () => {
    const target = app();
    const up = await request(target)
      .post(`${base}/media`)
      .set(bearer(users.agent.token))
      .field('kind', 'image')
      .attach('file', mediaFixture('sample.jpg'), {
        filename: 'photo.jpg',
        contentType: 'image/jpeg',
      });
    expect(up.status).toBe(201);
    expect(up.body.data).toMatchObject({ kind: 'image', mimeType: 'image/jpeg', voice: false });
    const clientId = randomUUID();
    const first = await send(
      users.agent.token,
      { type: 'image', mediaToken: up.body.data.mediaToken, caption: 'EMI chart', clientId },
      target,
    );
    expect(first.status).toBe(201);
    expect(first.body.data.media).toMatchObject({ status: 'ready', mimeType: 'image/jpeg' });
    const again = await send(
      users.agent.token,
      { type: 'image', mediaToken: up.body.data.mediaToken, caption: 'EMI chart', clientId },
      target,
    );
    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    // media link of the sent image
    const link = await request(target)
      .get(`${base}/messages/${first.body.data.id as string}/media`)
      .set(bearer(users.viewer.token));
    expect(link.body.data).toMatchObject({ mimeType: 'image/jpeg', expiresInSec: 300 });
    expect(link.body.data.url).toMatch(/\/files\/accounts\/.*sig=/);
    const bad = await request(target)
      .post(`${base}/media`)
      .set(bearer(users.agent.token))
      .field('kind', 'image')
      .attach('file', mediaFixture('sample.pdf'), 'x.png');
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('WHATSAPP_MEDIA_INVALID');
    const big = await request(target)
      .post(`${base}/media`)
      .set(bearer(users.agent.token))
      .field('kind', 'sticker')
      .attach(
        'file',
        Buffer.concat([mediaFixture('sample.webp'), Buffer.alloc(200 * 1024)]),
        's.webp',
      );
    expect(big.status).toBe(413);
    expect(
      (
        await request(target)
          .post(`${base}/media`)
          .set(bearer(users.agent.token))
          .field('kind', 'gif')
          .attach('file', mediaFixture('sample.jpg'), 'a.jpg')
      ).status,
    ).toBe(422);
    expect(
      (
        await request(target)
          .post(`${base}/media`)
          .set(bearer(users.agent.token))
          .field('kind', 'image')
      ).status,
    ).toBe(422);
    expect(
      (
        await request(target)
          .post(`${base}/media`)
          .set(bearer(users.agent.token))
          .field('kind', 'image')
          .attach('file', mediaFixture('sample.jpg'), 'a.jpg')
          .attach('other', mediaFixture('sample.jpg'), 'b.jpg')
      ).status,
    ).toBe(422);
    expect(
      (
        await request(target)
          .post(`${base}/media`)
          .set(bearer(users.viewer.token))
          .field('kind', 'image')
          .attach('file', mediaFixture('sample.jpg'), 'a.jpg')
      ).status,
    ).toBe(403);
    // without storage the inbox answers 503
    const noStorage = buildTestApp(
      {},
      { whatsapp: { ctx: world.w.ctx, jobs: waJobs, inboxJobs: world.jobs } },
    );
    expect(
      (await request(noStorage).get(`${base}/conversations`).set(bearer(users.agent.token))).status,
    ).toBe(503);
  });

  it('retry a failed send; retry a failed download (inbox.assign); links only for ready media', async () => {
    const target = app();
    const sent = await send(users.agent.token, { type: 'text', text: 'x' }, target);
    await MessageModel.updateOne(
      { _id: sent.body.data.id },
      { $set: { status: 'failed', error: { code: 131026, reason: 'Message undeliverable' } } },
    );
    const retried = await request(target)
      .post(`${base}/messages/${sent.body.data.id as string}/retry`)
      .set(bearer(users.agent.token));
    expect(retried.status).toBe(201);
    expect(retried.body.data).toMatchObject({ status: 'queued', retryOf: sent.body.data.id });
    const mediaId = await world.w.fake.putMedia(mediaFixture('sample.jpg'), 'image/jpeg');
    await world.fixture('messages-image.json', (p) => {
      const m = firstMessage(p);
      m.id = `wamid.R${String(Date.now())}`;
      m.from = '919000030001';
      m.timestamp = String(Math.floor(Date.now() / 1000));
      m.image = { id: mediaId, mime_type: 'image/jpeg' };
    });
    const img = (await world.messagesOf({ type: 'image' })).at(-1)!;
    expect(
      (
        await request(target)
          .get(`${base}/messages/${img._id.toString()}/media`)
          .set(bearer(users.agent.token))
      ).status,
    ).toBe(404);
    await MessageModel.updateOne({ _id: img._id }, { $set: { 'media.status': 'failed' } });
    expect(
      (
        await request(target)
          .post(`${base}/messages/${img._id.toString()}/media/retry`)
          .set(bearer(users.agent.token))
      ).status,
    ).toBe(403);
    expect(
      (
        await request(target)
          .post(`${base}/messages/${img._id.toString()}/media/retry`)
          .set(bearer(users.manager.token))
      ).status,
    ).toBe(204);
    await world.runJobs();
    expect(
      (
        await request(target)
          .get(`${base}/messages/${img._id.toString()}/media`)
          .set(bearer(users.agent.token))
      ).status,
    ).toBe(200);
  });

  it('sends are rate limited per user (60 / min)', async () => {
    const target = app();
    for (let i = 0; i < 60; i += 1)
      await send(users.agent.token, { type: 'note', text: String(i) }, target);
    const limited = await send(users.agent.token, { type: 'note', text: 'x' }, target);
    expect(limited.status).toBe(429);
    expect((await send(users.manager.token, { type: 'note', text: 'x' }, target)).status).toBe(201);
  });

  it('WhatsApp off → /inbox 503 (and no inbox settings route)', async () => {
    const off = buildTestApp({ WHATSAPP_ENABLED: 'false' });
    for (const url of [`${base}/summary`, `${base}/conversations`]) {
      const res = await request(off).get(url).set(bearer(users.owner.token));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('WHATSAPP_NOT_CONFIGURED');
    }
    expect(
      (await request(off).get('/api/v1/account/inbox-settings').set(bearer(users.owner.token)))
        .status,
    ).toBe(404);
  });
});

describe('/account/inbox-settings', () => {
  beforeEach(async () => {
    ({ users } = await world.setup());
  });

  it('read by everyone with account.read; owner / admin change it; keywords cleaned; audit names fields', async () => {
    const target = app();
    const got = await request(target)
      .get('/api/v1/account/inbox-settings')
      .set(bearer(users.viewer.token));
    expect(got.body.data).toMatchObject({
      sendReadReceipts: true,
      optOutReply: true,
      retentionDays: 90,
    });
    expect(got.body.data.optOutKeywords).toContain('BAND KARO');
    const patch = (t: string, body: Record<string, unknown>) =>
      request(target).patch('/api/v1/account/inbox-settings').set(bearer(t)).send(body);
    expect((await patch(users.manager.token, { sendReadReceipts: false })).status).toBe(403);
    const changed = await patch(users.admin.token, {
      sendReadReceipts: false,
      optOutKeywords: [' roko ', 'ROKO', 'stop'],
    });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({
      sendReadReceipts: false,
      optOutKeywords: ['ROKO', 'STOP'],
    });
    expect(
      (
        await AuditLogModel.findOne({
          action: 'inbox.settings_updated',
          accountId: state.acc.account._id,
        }).lean()
      )?.meta,
    ).toEqual({
      fields: ['sendReadReceipts', 'optOutKeywords'],
    });
    expect(
      (await patch(users.owner.token, { optInKeywords: ['stop'] })).body.error.details[0],
    ).toMatchObject({ path: 'optInKeywords' });
    expect((await patch(users.owner.token, { optOutKeywords: ['🙏'] })).status).toBe(422);
    expect((await patch(users.owner.token, {})).status).toBe(422);
    expect((await patch(users.owner.token, { notifyOnNewMessage: 'always' })).status).toBe(422);
    expect((await patch(users.owner.token, { optOutReplyText: 'x'.repeat(1025) })).status).toBe(
      422,
    );
    // no change → no audit
    const audits = await AuditLogModel.countDocuments({
      action: 'inbox.settings_updated',
      accountId: state.acc.account._id,
    });
    await patch(users.owner.token, { sendReadReceipts: false });
    expect(
      await AuditLogModel.countDocuments({
        action: 'inbox.settings_updated',
        accountId: state.acc.account._id,
      }),
    ).toBe(audits);
  });
});

describe('/whatsapp/channels/:id/profile', () => {
  beforeEach(async () => {
    ({ users } = await world.setup());
  });

  const png = (w: number, h: number) => {
    const chunk = (type: string, data: Buffer) => {
      const b = Buffer.alloc(12 + data.length);
      b.writeUInt32BE(data.length, 0);
      b.write(type, 4, 'latin1');
      data.copy(b, 8);
      return b;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(4))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  };

  it('read (whatsapp.read, cached), edit + photo (whatsapp.manage), validation, audit', async () => {
    const target = app();
    const url = `/api/v1/whatsapp/channels/${state.channel._id.toString()}/profile`;
    const got = await request(target).get(url).set(bearer(users.agent.token));
    expect(got.body.data).toMatchObject({ about: 'Hello from Test Business', vertical: 'OTHER' });
    expect(
      (await request(target).patch(url).set(bearer(users.manager.token)).send({ about: 'x' }))
        .status,
    ).toBe(403);
    const saved = await request(target)
      .patch(url)
      .set(bearer(users.admin.token))
      .send({
        about: 'Loans made simple',
        websites: ['https://example.com'],
        vertical: 'FINANCE',
        email: 'help@example.com',
      });
    expect(saved.body.data).toMatchObject({
      about: 'Loans made simple',
      vertical: 'FINANCE',
      websites: ['https://example.com'],
    });
    expect(
      (
        await AuditLogModel.findOne({
          action: 'whatsapp.profile_updated',
          accountId: state.acc.account._id,
        }).lean()
      )?.meta,
    ).toMatchObject({
      fields: expect.arrayContaining(['about', 'websites', 'vertical', 'email']) as string[],
      photo: false,
    });
    for (const bad of [
      { about: '' },
      { about: 'x'.repeat(140) },
      { websites: ['ftp://x', 'https://a', 'https://b'] },
      { vertical: 'SPACE' },
      { email: 'nope' },
      {},
    ]) {
      expect(
        (await request(target).patch(url).set(bearer(users.owner.token)).send(bad)).status,
        JSON.stringify(bad),
      ).toBe(422);
    }
    const photo = await request(target)
      .post(`${url}/photo`)
      .set(bearer(users.owner.token))
      .attach('file', png(256, 256), 'p.png');
    expect(photo.status).toBe(200);
    expect(photo.body.data.profilePictureUrl).toMatch(
      /^https:\/\/fake\.fbcdn\.net\/profile\/fake_handle_/,
    );
    expect(
      (
        await request(target)
          .post(`${url}/photo`)
          .set(bearer(users.owner.token))
          .attach('file', png(256, 200), 'p.png')
      ).status,
    ).toBe(422);
    expect(
      (
        await request(target)
          .post(`${url}/photo`)
          .set(bearer(users.owner.token))
          .attach('file', png(100, 100), 'p.png')
      ).status,
    ).toBe(422);
    expect(
      (
        await request(target)
          .post(`${url}/photo`)
          .set(bearer(users.owner.token))
          .attach('file', Buffer.from('GIF89a....'), 'p.gif')
      ).status,
    ).toBe(422);
    expect(
      (
        await request(target)
          .post(`${url}/photo`)
          .set(bearer(users.owner.token))
          .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), 'p.png')
      ).status,
    ).toBe(413);
    expect((await request(target).post(`${url}/photo`).set(bearer(users.owner.token))).status).toBe(
      422,
    );
    expect(
      (
        await request(target)
          .get(`/api/v1/whatsapp/channels/${'0'.repeat(24)}/profile`)
          .set(bearer(users.owner.token))
      ).status,
    ).toBe(404);
    world.w.fake.failNext('getBusinessProfile');
    await world.w.redis.del(`wa-profile-${state.channel._id.toString()}`);
    expect((await request(target).get(url).set(bearer(users.owner.token))).status).toBe(502);
  });

  it('image size from JPEG / PNG headers', () => {
    expect(imageSize(png(300, 300))).toEqual({ width: 300, height: 300 });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x40,
      0x01, 0x40, 0x01, 0x01, 0x11, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 320, height: 320 });
    expect(imageSize(Buffer.from('nope'))).toBeNull();
    expect(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(imageSize(mediaFixture('sample.jpg'))).toEqual({ width: 1, height: 1 });
  });
});

describe('conversation topics', () => {
  beforeEach(async () => {
    await setupWithChat();
  });

  it('own account + inbox.read; never another account; superadmins may watch', async () => {
    const topic = { kind: 'conversation' as const, id: convId };
    const ctx = (u: {
      user: { accountId: { toString(): string }; _id: { toString(): string } };
    }) => ({
      accountId: u.user.accountId.toString(),
      userId: u.user._id.toString(),
    });
    expect(await authorizeTopic(ctx(users.viewer), topic)).toBe(true);
    const custom = await RoleModel.create({
      accountId: state.acc.account._id,
      key: 'no-inbox',
      name: 'No inbox',
      isSystem: false,
      permissions: ['contacts.read'],
    });
    const noInbox = await state.acc.addUser('agent', { roleId: custom._id });
    expect(await authorizeTopic(ctx(noInbox), topic)).toBe(false);
    expect(
      await authorizeTopic(ctx(users.viewer), { kind: 'conversation', id: '0'.repeat(24) }),
    ).toBe(false);
    const mine = convId;
    await setupWithChat('919000034000');
    expect(await authorizeTopic(ctx(users.owner), { kind: 'conversation', id: mine })).toBe(false);
    const platform = await createTestAccount({
      isPlatform: true,
      slug: `p-topic-${Date.now()}`,
      name: 'P',
    });
    const superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
    expect(
      await authorizeTopic(
        {
          accountId: users.owner.user.accountId.toString(),
          userId: superadmin.user._id.toString(),
        },
        { kind: 'conversation', id: convId },
      ),
    ).toBe(true);
  });
});
