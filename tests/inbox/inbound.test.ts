import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { signWebhook } from '../../src/core/meta';
import { setRealtime } from '../../src/core/realtime';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { DndEntryModel } from '../../src/db/models/dnd-entry.model';
import { MessageModel } from '../../src/db/models/message.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { UserModel } from '../../src/db/models/user.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { INBOX_JOBS } from '../../src/modules/inbox/jobs';
import {
  downloadInboundMedia,
  mediaLink,
  retryMediaDownload,
} from '../../src/modules/inbox/media.service';
import { queueSystemText } from '../../src/modules/inbox/outbound.service';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../../src/modules/whatsapp/webhooks.service';
import { createLogger, setLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import {
  customerText,
  firstMessage,
  mediaFixture,
  uniqueWamid,
  useInboxWorld,
  valueOf,
} from '../helpers/inbox';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;

const events: {
  scope: 'account' | 'user' | 'topic';
  target: string;
  type: string;
  data: unknown;
}[] = [];
beforeEach(() => {
  events.length = 0;
  setRealtime({
    pushToAccount: (target: string, type: string, data: unknown) => {
      events.push({ scope: 'account', target, type, data });
      return Promise.resolve();
    },
    pushToUser: (_a: string, target: string, type: string, data: unknown) => {
      events.push({ scope: 'user', target, type, data });
      return Promise.resolve();
    },
    pushToTopic: (target: string, type: string, data: unknown) => {
      events.push({ scope: 'topic', target, type, data });
      return Promise.resolve();
    },
  } as never);
});
afterEach(() => setRealtime(undefined));

const FIXTURES = join(__dirname, '../fixtures/meta');
const messageFixtures = readdirSync(FIXTURES).filter((f) => f.startsWith('messages-'));
const customer = (suffix: number) => `9190000${String(10000 + suffix).padStart(5, '0')}`;

/** A fixture as a fresh message from `from` (unique wamid, now). */
const deliverFixture = (name: string, from: string, edit?: (m: Record<string, unknown>) => void) =>
  world.fixture(name, (p) => {
    const m = firstMessage(p);
    m.id = uniqueWamid();
    m.from = from;
    m.timestamp = String(Math.floor(Date.now() / 1000));
    const v = valueOf(p);
    v.contacts = [{ profile: { name: 'Test Customer' }, wa_id: from }];
    edit?.(m);
  });

const conversationOf = (waId: string) =>
  ConversationModel.findOne({ accountId: state.acc.account._id, waId }).lean();

describe('inbound — every type end to end', () => {
  beforeEach(async () => {
    await world.setup();
  });

  it.each(messageFixtures)('%s', async (name) => {
    const from = customer(messageFixtures.indexOf(name));
    expect(await deliverFixture(name, from)).toEqual(['processed']);
    const conv = await conversationOf(from);
    const [msg] = await world.messagesOf({ conversationId: conv?._id });
    expect(msg).toMatchObject({ direction: 'in', origin: 'customer', status: 'received' });
    const type = msg?.type;
    expect(conv).toMatchObject({ status: 'open', source: 'inbound', profileName: 'Test Customer' });
    // unread / list row: not for reactions and system lines
    if (type === 'reaction' || type === 'system') {
      expect(conv?.unreadCount).toBe(0);
    } else {
      expect(conv?.unreadCount).toBe(1);
      expect(conv?.lastMessage?.id).toEqual(msg?._id);
    }
    if (type !== 'system') {
      expect(conv?.windowExpiresAt?.getTime()).toBe(
        (conv?.lastInboundAt?.getTime() ?? 0) + 24 * 3_600_000,
      );
    }
    const media = ['image', 'video', 'audio', 'document', 'sticker'].includes(type ?? '');
    expect(world.jobs.sent.filter((j) => j.name === INBOX_JOBS.mediaDownload)).toHaveLength(
      media ? 1 : 0,
    );
    // account events never carry text; the topic carries the full view
    for (const e of events.filter((x) => x.scope === 'account')) {
      expect(JSON.stringify(e.data)).not.toMatch(
        /Test (photo|link|reply|forwarded|statement|video)/,
      );
      expect(JSON.stringify(e.data)).not.toContain(from);
    }
    const created = events.find((e) => e.type === 'inbox.message.created');
    if (type === 'reaction') expect(created).toBeUndefined();
    else
      expect(created).toMatchObject({
        scope: 'topic',
        target: `conversation:${String(conv?._id)}`,
      });
    expect(events.some((e) => e.type === 'inbox.conversation.updated')).toBe(true);
    expect(events.some((e) => e.type === 'inbox.summary.updated')).toBe(true);
    const contact = await ContactModel.findOne({
      accountId: state.acc.account._id,
      phoneE164: `+${from}`,
    }).lean();
    expect(contact).toMatchObject({
      name: 'Test Customer',
      source: { type: 'whatsapp' },
      whatsapp: { waId: from, profileName: 'Test Customer' },
    });
  });
});

describe('inbound — dedupe, order, races, contacts', () => {
  beforeEach(async () => {
    await world.setup();
  });

  it('the same message twice → one row, one bell; duplicates of a status are ignored', async () => {
    const payload = customerText(state.channel, { from: customer(101), text: 'Once' });
    await world.deliver(payload);
    // Meta redelivers the exact payload (receiver dedupes) and a re-sent copy with a new envelope
    await world.deliver(payload);
    const copy = customerText(state.channel, {
      from: customer(101),
      id: firstMessage(payload).id as string,
    });
    (copy.entry[0]!.changes[0]!.value.contacts as unknown[]).length = 0;
    await world.deliver(copy);
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(1);
    const conv = await conversationOf(customer(101));
    expect(conv?.unreadCount).toBe(1);
    // owner, admin, manager, agent (viewers can't reply)
    expect(
      await NotificationModel.countDocuments({
        accountId: state.acc.account._id,
        type: 'inbox.message_received',
      }),
    ).toBe(4);
  });

  it('out of order: an older message arriving later never replaces the list row or the window', async () => {
    const now = Math.floor(Date.now() / 1000);
    await world.deliver(
      customerText(state.channel, { from: customer(102), text: 'Second', at: now }),
    );
    await world.deliver(
      customerText(state.channel, { from: customer(102), text: 'First', at: now - 60 }),
    );
    const conv = await conversationOf(customer(102));
    expect(conv?.lastMessage?.preview).toBe('Second');
    expect(conv?.lastInboundAt?.getTime()).toBe(now * 1000);
    expect(conv?.unreadCount).toBe(2);
    const msgs = await world.messagesOf({ conversationId: conv?._id });
    expect(msgs.map((m) => m.text)).toEqual(['First', 'Second']);
  });

  it('ten first messages of a new customer at once → one contact, one conversation, unread 10', async () => {
    const from = customer(103);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        world.deliver(customerText(state.channel, { from, text: `Burst ${String(i)}` })),
      ),
    );
    expect(
      await ContactModel.countDocuments({
        accountId: state.acc.account._id,
        phoneE164: `+${from}`,
      }),
    ).toBe(1);
    expect(
      await ConversationModel.countDocuments({ accountId: state.acc.account._id, waId: from }),
    ).toBe(1);
    expect((await conversationOf(from))?.unreadCount).toBe(10);
  });

  it('matches an existing contact; never revives a deleted one; keeps a name a person gave', async () => {
    const from = customer(104);
    const named = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${from}`,
      name: 'Asha (CRM)',
      source: { type: 'manual' },
    });
    await world.deliver(customerText(state.channel, { from, name: 'Asha WhatsApp' }));
    const read = await ContactModel.findById(named._id).lean();
    expect(read).toMatchObject({
      name: 'Asha (CRM)',
      whatsapp: { profileName: 'Asha WhatsApp', waId: from },
    });
    expect((await conversationOf(from))?.contactId).toEqual(named._id);

    // a manual contact without a name takes the profile name
    const from2 = customer(105);
    const unnamed = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${from2}`,
      source: { type: 'import' },
    });
    await world.deliver(customerText(state.channel, { from: from2, name: 'Ravi' }));
    expect((await ContactModel.findById(unnamed._id).lean())?.name).toBe('Ravi');

    // WhatsApp-created contacts follow the profile name until a person renames them
    const from3 = customer(106);
    await world.deliver(customerText(state.channel, { from: from3, name: 'Old Name' }));
    await world.deliver(customerText(state.channel, { from: from3, name: 'New Name' }));
    const auto = await ContactModel.findOne({
      accountId: state.acc.account._id,
      phoneE164: `+${from3}`,
    }).lean();
    expect(auto?.name).toBe('New Name');
    await ContactModel.updateOne(
      { _id: auto?._id },
      { $set: { 'whatsapp.nameEditedAt': new Date() } },
    );
    await world.deliver(customerText(state.channel, { from: from3, name: 'Third Name' }));
    expect((await ContactModel.findById(auto?._id).lean())?.name).toBe('New Name');

    // deleted → a new contact; the chat follows the live one
    await ContactModel.updateOne({ _id: named._id }, { $set: { deletedAt: new Date() } });
    await world.deliver(customerText(state.channel, { from, name: 'Asha WhatsApp' }));
    const live = await ContactModel.findOne({
      accountId: state.acc.account._id,
      phoneE164: `+${from}`,
      deletedAt: null,
    }).lean();
    expect(live?._id).not.toEqual(named._id);
    expect((await conversationOf(from))?.contactId).toEqual(live?._id);
    // no profile in the webhook → number only, DND state copied
    const from4 = customer(107);
    await DndEntryModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${from4}`,
      source: 'manual',
    });
    await world.deliver(customerText(state.channel, { from: from4, name: null }));
    expect(
      await ContactModel.findOne({
        accountId: state.acc.account._id,
        phoneE164: `+${from4}`,
      }).lean(),
    ).toMatchObject({
      name: null,
      dnd: true,
    });
  });

  it('a closed conversation reopens on a customer message; other accounts never see it', async () => {
    const from = customer(108);
    await world.deliver(customerText(state.channel, { from }));
    await ConversationModel.updateOne(
      { accountId: state.acc.account._id, waId: from },
      { $set: { status: 'closed', closedAt: new Date() } },
    );
    await world.deliver(customerText(state.channel, { from }));
    expect(await conversationOf(from)).toMatchObject({ status: 'open', closedAt: null });
    const firstAccount = state.acc.account._id;
    await world.setup();
    await world.deliver(customerText(state.channel, { from }));
    expect(await ConversationModel.countDocuments({ waId: from })).toBe(2);
    expect(await ConversationModel.countDocuments({ accountId: firstAccount, waId: from })).toBe(1);
  });
});

describe('inbound — replies, reactions', () => {
  beforeEach(async () => {
    await world.setup();
  });

  it('a reply links the quoted message; reactions land on their target and replace / remove', async () => {
    const from = customer(120);
    const original = customerText(state.channel, { from, text: 'Original' });
    await world.deliver(original);
    const originalId = firstMessage(original).id as string;
    await deliverFixture('messages-reply.json', from, (m) => {
      m.context = { from: '919000000010', id: originalId };
    });
    const [orig, reply] = await world.messagesOf();
    expect(reply?.context?.replyToMessageId).toEqual(orig?._id);
    const created = events.filter((e) => e.type === 'inbox.message.created').at(-1)?.data as {
      message: { replyTo: { id: string; preview: string } | null };
    };
    expect(created.message.replyTo).toMatchObject({
      id: orig?._id.toString(),
      preview: 'Original',
    });

    await deliverFixture('messages-reaction.json', from, (m) => {
      m.reaction = { message_id: originalId, emoji: '👍' };
    });
    await deliverFixture('messages-reaction.json', from, (m) => {
      m.reaction = { message_id: originalId, emoji: '❤️' };
    });
    let target = await MessageModel.findById(orig?._id).lean();
    expect(target?.reactions.map((r) => [r.emoji, r.by])).toEqual([['❤️', 'customer']]);
    expect(events.some((e) => e.type === 'inbox.message.updated')).toBe(true);
    await deliverFixture('messages-reaction-removed.json', from, (m) => {
      m.reaction = { message_id: originalId };
    });
    target = await MessageModel.findById(orig?._id).lean();
    expect(target?.reactions).toEqual([]);
    // a reaction to a message we don't have is still stored (no target)
    await deliverFixture('messages-reaction.json', from, (m) => {
      m.reaction = { message_id: 'wamid.UNKNOWN', emoji: '😂' };
    });
    const last = (await world.messagesOf({ type: 'reaction' })).at(-1);
    expect(last?.reaction).toMatchObject({ targetMessageId: null, emoji: '😂' });
    // reactions never count as unread / list row
    const conv = await conversationOf(from);
    expect(conv?.unreadCount).toBe(2);
    expect(conv?.lastMessage?.preview).toBe('Test reply to your message');
  });
});

describe('inbound — media downloads', () => {
  beforeEach(async () => {
    await world.setup();
  });

  const inboundImage = async (
    from: string,
    bytes = mediaFixture('sample.jpg'),
    mime = 'image/jpeg',
  ) => {
    const mediaId = await world.w.fake.putMedia(bytes, mime);
    await deliverFixture('messages-image.json', from, (m) => {
      m.image = { id: mediaId, mime_type: mime, caption: 'Test photo' };
    });
    const msg = (await world.messagesOf({ type: 'image' })).at(-1);
    if (!msg) throw new Error('no image');
    return { msg, mediaId };
  };

  it('downloads to storage (sniffed, hashed), signed link, WS update', async () => {
    const { msg } = await inboundImage(customer(130));
    expect(await world.runJobs()).toEqual(['ready']);
    const read = await MessageModel.findById(msg._id).lean();
    expect(read?.media).toMatchObject({
      status: 'ready',
      mimeType: 'image/jpeg',
      size: mediaFixture('sample.jpg').length,
      storageKey: `accounts/${state.acc.account._id.toString()}/inbox-media/${msg._id.toString()}.jpg`,
      error: null,
    });
    expect(read?.media?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await world.storage.exists(read?.media?.storageKey ?? '')).toBe(true);
    expect(await mediaLink(state.ix, read!)).toMatch(/\/files\/accounts\//);
    expect(
      events.some(
        (e) =>
          e.type === 'inbox.message.updated' &&
          (e.data as { media: { status: string } }).media.status === 'ready',
      ),
    ).toBe(true);
    // ready → a second run is a no-op
    expect(await downloadInboundMedia(state.ix, msg._id.toString(), { finalAttempt: true })).toBe(
      'skipped',
    );
    await retryMediaDownload(state.ix, read!);
    expect(world.jobs.sent).toEqual([]);
  });

  it('retryable errors are rethrown until the last attempt, then failed; manual retry re-queues', async () => {
    const { msg } = await inboundImage(customer(131));
    world.jobs.sent.length = 0;
    world.w.fake.failNext('getMediaUrl');
    await expect(
      downloadInboundMedia(state.ix, msg._id.toString(), { finalAttempt: false }),
    ).rejects.toBeTruthy();
    expect((await MessageModel.findById(msg._id).lean())?.media?.status).toBe('pending');
    world.w.fake.failNext('getMediaUrl');
    expect(await downloadInboundMedia(state.ix, msg._id.toString(), { finalAttempt: true })).toBe(
      'failed',
    );
    const failed = await MessageModel.findById(msg._id).lean();
    expect(failed?.media).toMatchObject({
      status: 'failed',
      error: "Media couldn't be downloaded",
    });
    await retryMediaDownload(state.ix, failed!);
    expect((await MessageModel.findById(msg._id).lean())?.media?.status).toBe('pending');
    expect(world.jobs.sent).toEqual([{ name: INBOX_JOBS.mediaDownload, id: msg._id.toString() }]);
    expect(await world.runJobs()).toEqual(['ready']);
  });

  it('wrong type, gone media, expired (> 7 days), disconnected numbers, token revoked', async () => {
    const wrong = await inboundImage(customer(132), mediaFixture('sample.pdf'), 'image/jpeg');
    expect(await world.runJobs()).toEqual(['failed']);
    expect((await MessageModel.findById(wrong.msg._id).lean())?.media?.error).toBe(
      "The media doesn't match its type",
    );

    const gone = await inboundImage(customer(133));
    await world.w.fake.deleteMedia(gone.mediaId);
    expect(await world.runJobs({ finalAttempt: false })).toEqual(['failed']);

    const old = await inboundImage(customer(134));
    await MessageModel.updateOne(
      { _id: old.msg._id },
      { $set: { at: new Date(Date.now() - 8 * 86_400_000) } },
    );
    expect(await world.runJobs()).toEqual(['expired']);
    await expect(
      retryMediaDownload(state.ix, (await MessageModel.findById(old.msg._id).lean())!),
    ).rejects.toMatchObject({
      code: 'INBOX_MEDIA_EXPIRED',
    });
    await expect(
      mediaLink(state.ix, (await MessageModel.findById(old.msg._id).lean())!),
    ).rejects.toMatchObject({ status: 404 });

    const off = await inboundImage(customer(135));
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { tokenSealed: null } },
    );
    expect(await world.runJobs({ finalAttempt: false })).toEqual(['failed']);
    expect((await MessageModel.findById(off.msg._id).lean())?.media?.error).toBe(
      'The WhatsApp number is not connected',
    );
    expect(
      await downloadInboundMedia(state.ix, '000000000000000000000000', { finalAttempt: true }),
    ).toBe('skipped');
    const textMsg = (await world.messagesOf({ type: 'text' })).at(0);
    if (textMsg) {
      await expect(retryMediaDownload(state.ix, textMsg)).rejects.toMatchObject({ status: 404 });
    }
  });

  it('a revoked token marks the number for reconnect and fails the download', async () => {
    const { msg } = await inboundImage(customer(136));
    await world.w.fake.revokeToken(state.token);
    expect(await world.runJobs({ finalAttempt: false })).toEqual(['failed']);
    expect((await WhatsAppChannelModel.findById(state.channel._id).lean())?.status).toBe(
      'needs_reconnect',
    );
    expect((await MessageModel.findById(msg._id).lean())?.media?.status).toBe('failed');
  });
});

describe('inbound — statuses', () => {
  beforeEach(async () => {
    await world.setup();
  });

  /** An outgoing message we "sent" (wamid known) to `from`. */
  const outgoing = async (from: string) => {
    await world.deliver(customerText(state.channel, { from }));
    const conv = await conversationOf(from);
    const wamid = uniqueWamid();
    const msg = await MessageModel.create({
      accountId: state.acc.account._id,
      conversationId: conv!._id,
      channelId: state.channel._id,
      contactId: conv!.contactId,
      direction: 'out',
      origin: 'agent',
      type: 'text',
      text: 'Our reply',
      status: 'accepted',
      waMessageId: wamid,
      at: new Date(),
    });
    await ConversationModel.updateOne(
      { _id: conv!._id },
      {
        $set: {
          lastMessage: {
            id: msg._id,
            direction: 'out',
            type: 'text',
            preview: 'Our reply',
            at: msg.at,
            status: 'accepted',
          },
        },
      },
    );
    return { msg, wamid, conv: conv! };
  };
  const status = (wamid: string, value: string, extra: Record<string, unknown> = {}) =>
    world.fixture('statuses-sent.json', (p) => {
      const s = (valueOf(p).statuses as Record<string, unknown>[])[0]!;
      Object.assign(
        s,
        { id: wamid, status: value, timestamp: String(Math.floor(Date.now() / 1000)) },
        extra,
      );
    });

  it('forward only, out of order safe, timeline deduped, pricing stored, list tick follows', async () => {
    const { msg, wamid, conv } = await outgoing(customer(140));
    await status(wamid, 'read');
    await status(wamid, 'delivered'); // late
    await status(wamid, 'sent'); // late
    await status(wamid, 'read'); // duplicate
    const read = await MessageModel.findById(msg._id).lean();
    expect(read?.status).toBe('read');
    expect(read?.statusHistory.map((s) => s.status)).toEqual(['read']);
    expect(read?.pricing).toMatchObject({
      billable: false,
      model: 'PMP',
      category: 'service',
      conversationOrigin: 'service',
    });
    expect((await ConversationModel.findById(conv._id).lean())?.lastMessage?.status).toBe('read');
    expect(events.filter((e) => e.type === 'inbox.message.updated')).toHaveLength(1);
  });

  it('failed with our reason; failure after delivery ignored; delivered after failure recovers', async () => {
    const a = await outgoing(customer(141));
    await status(a.wamid, 'sent');
    await world.fixture('statuses-failed.json', (p) => {
      const s = (valueOf(p).statuses as Record<string, unknown>[])[0]!;
      s.id = a.wamid;
    });
    expect(await MessageModel.findById(a.msg._id).lean()).toMatchObject({
      status: 'failed',
      error: { code: 131026, title: 'Message undeliverable', reason: 'Message undeliverable' },
    });
    await status(a.wamid, 'delivered');
    expect(await MessageModel.findById(a.msg._id).lean()).toMatchObject({
      status: 'delivered',
      error: null,
    });
    await world.fixture('statuses-failed.json', (p) => {
      const s = (valueOf(p).statuses as Record<string, unknown>[])[0]!;
      s.id = a.wamid;
    });
    expect((await MessageModel.findById(a.msg._id).lean())?.status).toBe('delivered');
    // a status without pricing keeps a late duplicate's pricing
    const b = await outgoing(customer(142));
    await status(b.wamid, 'sent', { pricing: undefined, conversation: undefined });
    expect((await MessageModel.findById(b.msg._id).lean())?.pricing).toBeNull();
    await status(b.wamid, 'sent');
    expect((await MessageModel.findById(b.msg._id).lean())?.pricing).toMatchObject({
      category: 'service',
    });
  });

  it('played → read; deleted for inbound messages; unknown wamids and odd statuses are counted, not stored', async () => {
    const a = await outgoing(customer(143));
    await status(a.wamid, 'played');
    expect((await MessageModel.findById(a.msg._id).lean())?.status).toBe('read');
    const inbound = (await world.messagesOf({ direction: 'in' })).at(-1)!;
    await status(inbound.waMessageId!, 'deleted');
    expect((await MessageModel.findById(inbound._id).lean())?.status).toBe('deleted');
    await status('wamid.NOT_OURS', 'delivered');
    await status(a.wamid, 'warning');
    expect(await MessageModel.countDocuments({ waMessageId: 'wamid.NOT_OURS' })).toBe(0);
  });

  it('a failed status with 368 restricts the number; with no code keeps it', async () => {
    const a = await outgoing(customer(144));
    await status(a.wamid, 'failed', { errors: [{ code: 368, title: 'Temporarily blocked' }] });
    expect((await MessageModel.findById(a.msg._id).lean())?.error?.reason).toBe(
      'Account restricted by Meta',
    );
    expect((await WhatsAppChannelModel.findById(state.channel._id).lean())?.status).toBe(
      'restricted',
    );
    const b = await outgoing(customer(145));
    await status(b.wamid, 'failed', { errors: [] });
    expect((await MessageModel.findById(b.msg._id).lean())?.error).toMatchObject({
      code: null,
      reason: 'Message failed',
    });
  });
});

describe('inbound — opt-out / opt-in keywords', () => {
  beforeEach(async () => {
    await world.setup();
  });

  const say = (from: string, text: string) =>
    world.deliver(customerText(state.channel, { from, text }));
  const contactOf = (from: string) =>
    ContactModel.findOne({ accountId: state.acc.account._id, phoneE164: `+${from}` }).lean();

  it('STOP → opted out + WhatsApp DND + system line + audit + one confirmation; START → cleared', async () => {
    const from = customer(150);
    await say(from, 'STOP');
    let contact = await contactOf(from);
    expect(contact?.optedOutAt).toBeInstanceOf(Date);
    expect(contact?.dnd).toBe(true);
    expect(
      await DndEntryModel.findOne({
        accountId: state.acc.account._id,
        phoneE164: `+${from}`,
      }).lean(),
    ).toMatchObject({
      source: 'whatsapp',
      reason: 'WhatsApp STOP',
    });
    const msgs = await world.messagesOf();
    expect(msgs.map((m) => [m.type, m.origin, m.status])).toEqual([
      ['text', 'customer', 'received'],
      ['system', 'system', 'received'],
      ['text', 'system', 'queued'],
    ]);
    expect(msgs[1]?.system?.kind).toBe('opted_out');
    expect(msgs[2]?.text).toContain('Reply START to opt in again');
    expect(world.jobs.sent).toContainEqual({
      name: INBOX_JOBS.messageSend,
      id: msgs[2]?._id.toString(),
    });
    const audit = await AuditLogModel.findOne({
      accountId: state.acc.account._id,
      action: 'inbox.contact_opted_out',
    }).lean();
    expect(audit).toMatchObject({
      actor: { type: 'system' },
      target: { type: 'contact' },
      meta: { kind: 'opt_out' },
    });
    expect(JSON.stringify(audit?.meta)).not.toContain('STOP');

    // again (any spelling) → nothing new (idempotent)
    await say(from, 'band karo!');
    await say(from, 'बंद करो।');
    expect(
      await AuditLogModel.countDocuments({
        accountId: state.acc.account._id,
        action: 'inbox.contact_opted_out',
      }),
    ).toBe(1);
    expect((await world.messagesOf({ origin: 'system', type: 'text' })).length).toBe(1);

    await say(from, 'shuru');
    contact = await contactOf(from);
    expect(contact).toMatchObject({ optedOutAt: null, dnd: false });
    expect(
      await DndEntryModel.countDocuments({
        accountId: state.acc.account._id,
        phoneE164: `+${from}`,
      }),
    ).toBe(0);
    const optIn = await world.messagesOf({ origin: 'system' });
    expect(optIn.map((m) => m.system?.kind ?? m.text)).toEqual([
      'opted_out',
      expect.stringContaining('START') as string,
      'opted_in',
      expect.stringContaining('subscribed again') as string,
    ]);
    // START again → nothing
    await say(from, 'START');
    expect(
      await AuditLogModel.countDocuments({
        accountId: state.acc.account._id,
        action: 'inbox.contact_opted_in',
      }),
    ).toBe(1);
    // STOP again within 24 h → opted out, but no second confirmation (cooldown)
    await say(from, 'unsubscribe');
    expect((await contactOf(from))?.optedOutAt).toBeInstanceOf(Date);
    expect((await world.messagesOf({ origin: 'system', type: 'text' })).length).toBe(2);
  });

  it('keywords follow message time, not processing order (START after STOP wins even if processed first)', async () => {
    const from = customer(156);
    const t = Math.floor(Date.now() / 1000);
    await world.deliver(customerText(state.channel, { from, text: 'START', at: t + 5 }));
    await world.deliver(customerText(state.channel, { from, text: 'STOP', at: t }));
    expect((await contactOf(from))?.optedOutAt).toBeNull();
    // and the other way round: an older START processed after a newer STOP is ignored
    const from2 = customer(157);
    await world.deliver(customerText(state.channel, { from: from2, text: 'STOP', at: t + 5 }));
    await world.deliver(customerText(state.channel, { from: from2, text: 'START', at: t }));
    expect((await contactOf(from2))?.optedOutAt).toBeInstanceOf(Date);
    // STOP and START at once (parallel workers) end in the later one's state
    const from3 = customer(158);
    await Promise.all([
      world.deliver(customerText(state.channel, { from: from3, text: 'STOP', at: t })),
      world.deliver(customerText(state.channel, { from: from3, text: 'START', at: t + 1 })),
    ]);
    expect((await contactOf(from3))?.optedOutAt).toBeNull();
  });

  it('a person-added DND entry stays on opt-in; sentences never match; button replies count; settings respected', async () => {
    const from = customer(151);
    await DndEntryModel.create({
      accountId: state.acc.account._id,
      phoneE164: `+${from}`,
      source: 'manual',
      reason: 'Asked on call',
    });
    await say(from, 'Stop');
    await say(from, 'START');
    expect(await contactOf(from)).toMatchObject({ optedOutAt: null, dnd: true });
    expect((await world.messagesOf({ type: 'system' })).at(-1)?.system?.kind).toBe(
      'opted_in_dnd_kept',
    );
    const audit = await AuditLogModel.findOne({
      accountId: state.acc.account._id,
      action: 'inbox.contact_opted_in',
    }).lean();
    expect(audit?.meta).toMatchObject({ dndKept: true });

    const from2 = customer(152);
    await say(from2, 'mera order band karo mat');
    expect((await contactOf(from2))?.optedOutAt).toBeNull();

    // replies off + custom keyword; interactive button title counts
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.inbox.optOutReply': false, 'settings.inbox.optOutKeywords': ['ROKO'] } },
    );
    const from3 = customer(153);
    await deliverFixture('messages-button-reply.json', from3, (m) => {
      m.interactive = { type: 'button_reply', button_reply: { id: 'x', title: 'Roko' } };
    });
    expect((await contactOf(from3))?.optedOutAt).toBeInstanceOf(Date);
    const conv3 = await conversationOf(from3);
    expect(
      await world.messagesOf({ conversationId: conv3?._id, origin: 'system', type: 'text' }),
    ).toHaveLength(0);
    await say(customer(154), 'STOP');
    expect((await contactOf(customer(154)))?.optedOutAt).toBeNull();
  });

  it('no confirmation outside the window (system message keyword inside an old window cannot happen; queue skip covered)', async () => {
    const from = customer(155);
    await say(from, 'Hello');
    const conv = await conversationOf(from);
    await ConversationModel.updateOne(
      { _id: conv?._id },
      { $set: { windowExpiresAt: new Date(Date.now() - 1000) } },
    );
    const closed = await ConversationModel.findById(conv?._id).lean();
    expect(await queueSystemText(state.ix, closed!, 'x')).toBeNull();
    await ConversationModel.updateOne({ _id: conv?._id }, { $set: { windowExpiresAt: null } });
    expect(
      await queueSystemText(state.ix, (await ConversationModel.findById(conv?._id).lean())!, 'x'),
    ).toBeNull();
  });
});

describe('inbound — notifications', () => {
  beforeEach(async () => {
    await world.setup();
  });

  const bells = () =>
    NotificationModel.find({
      accountId: state.acc.account._id,
      type: 'inbox.message_received',
    }).lean();

  it('unassigned → everyone who can reply (not viewers), once per throttle window, name only', async () => {
    const from = customer(160);
    await world.deliver(
      customerText(state.channel, { from, text: 'Secret loan details', name: 'Asha' }),
    );
    await world.deliver(customerText(state.channel, { from, text: 'Second' }));
    const rows = await bells();
    expect(rows).toHaveLength(4); // owner, admin, manager, agent
    expect(rows[0]).toMatchObject({ title: 'New WhatsApp message', body: 'Asha' });
    expect(rows[0]?.link).toMatch(/^\/inbox\/[0-9a-f]{24}$/);
    expect(JSON.stringify(rows)).not.toContain('Secret');
  });

  it('assigned → only the assignee; assigned_only / off modes; reactions and system lines never ring', async () => {
    const from = customer(161);
    await world.deliver(customerText(state.channel, { from, name: null }));
    const conv = await conversationOf(from);
    await NotificationModel.deleteMany({ accountId: state.acc.account._id });
    await world.w.redis.del(`inbox-notify-${String(conv?._id)}`);
    const agent = await UserModel.findOne({
      accountId: state.acc.account._id,
      email: /^agent-/,
    }).lean();
    await ConversationModel.updateOne({ _id: conv?._id }, { $set: { assignedTo: agent?._id } });
    await world.deliver(customerText(state.channel, { from, name: null }));
    const rows = await bells();
    expect(rows.map((r) => r.userId.toString())).toEqual([agent?._id.toString()]);
    expect(rows[0]?.body).toMatch(/^\+91 •••• \d{4}$/);

    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.inbox.notifyOnNewMessage': 'assigned_only' } },
    );
    await world.deliver(customerText(state.channel, { from: customer(162) }));
    expect(await bells()).toHaveLength(1);
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.inbox.notifyOnNewMessage': 'off' } },
    );
    await world.w.redis.del(`inbox-notify-${String(conv?._id)}`);
    await world.deliver(customerText(state.channel, { from }));
    expect(await bells()).toHaveLength(1);
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.inbox.notifyOnNewMessage': 'assigned_or_all' } },
    );
    await deliverFixture('messages-reaction.json', customer(163));
    await deliverFixture('messages-system-number-changed.json', customer(164));
    expect(await bells()).toHaveLength(1);
  });
});

describe('inbound — schema, routing and logs', () => {
  beforeEach(async () => {
    await world.setup();
  });

  it('a bad messages value fails the event; unreadable messages are skipped; top-level errors logged', async () => {
    const bad = customerText(state.channel);
    (bad.entry[0]!.changes[0]!.value as Record<string, unknown>).metadata = {
      phone_number_id: state.channel.phoneNumberId,
    };
    (bad.entry[0]!.changes[0]!.value as Record<string, unknown>).statuses = [{ id: 1 }];
    expect(await world.deliver(bad)).toEqual(['failed']);

    const odd = customerText(state.channel);
    (odd.entry[0]!.changes[0]!.value as Record<string, unknown>).messages = [
      { broken: true },
      { id: 'x', from: '' },
    ];
    (odd.entry[0]!.changes[0]!.value as Record<string, unknown>).errors = [{ code: 131000 }];
    expect(await world.deliver(odd)).toEqual(['processed']);
    expect(await MessageModel.countDocuments({ accountId: state.acc.account._id })).toBe(0);
  });

  it('without the inbox hooks (Phase 9 worker) messages stay deferred 30 days', async () => {
    const ids: string[] = [];
    const raw = Buffer.from(JSON.stringify(customerText(state.channel)));
    await receiveWebhook(
      world.w.ctx,
      { enqueueEvent: (id) => (ids.push(id), Promise.resolve()) },
      raw,
      signWebhook(raw, world.w.env.FAKE_META_APP_SECRET ?? ''),
    );
    expect(
      await processWebhookEvent({ ctx: world.w.ctx, service: world.w.svc }, ids[0]!, {
        finalAttempt: false,
      }),
    ).toBe('deferred');
    const event = await MetaWebhookEventModel.findById(ids[0]).lean();
    expect((event?.expiresAt.getTime() ?? 0) - (event?.receivedAt.getTime() ?? 0)).toBe(
      30 * 86_400_000,
    );
  });

  it('logs never carry texts, numbers, names, file names or media urls', async () => {
    const lines: string[] = [];
    setLogger(
      createLogger(
        { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
        new Writable({
          write(chunk: Buffer, _e, done) {
            lines.push(chunk.toString());
            done();
          },
        }),
      ),
    );
    try {
      const from = customer(170);
      for (const name of messageFixtures) await deliverFixture(name, from);
      await world.runJobs({ finalAttempt: false }).catch(() => undefined);
      await world.deliver(customerText(state.channel, { from, text: 'STOP' }));
      const logs = lines.join('\n');
      for (const leak of [
        from,
        `+${from}`,
        'Test Customer',
        'Test photo caption',
        'Test link',
        'test-statement.pdf',
        'Test Office',
        'Test Friend',
        'friend@example.com',
        'lookaside',
        '/dev/meta/media/',
        'fake_tok_',
      ]) {
        expect(logs, leak).not.toContain(leak);
      }
    } finally {
      setLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    }
    vi.restoreAllMocks();
  });
});
