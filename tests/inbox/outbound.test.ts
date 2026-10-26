import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import type { Job } from 'bullmq';
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { graphError } from '../../src/core/meta';
import {
  MAINTENANCE_SCHEDULES,
  processMaintenanceJob,
} from '../../src/core/queues/workers/maintenance.worker';
import { processWhatsAppJob } from '../../src/core/queues/workers/whatsapp.worker';
import { setRealtime } from '../../src/core/realtime';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../src/db/models/conversation.model';
import { InboxUploadModel } from '../../src/db/models/inbox-upload.model';
import { MessageModel, type MessageDoc } from '../../src/db/models/message.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { INBOX_JOBS, INBOX_RETENTION_JOB } from '../../src/modules/inbox/jobs';
import { SendMessageBody, type SendMessageInput } from '../../src/modules/inbox/outbound.schema';
import { retryMessage, sendMessage } from '../../src/modules/inbox/outbound.service';
import {
  markConversationRead,
  markConversationUnread,
  processReadReceipt,
  sendTyping,
} from '../../src/modules/inbox/receipts';
import { runInboxRetention } from '../../src/modules/inbox/retention.job';
import { processSend } from '../../src/modules/inbox/send.job';
import { createUpload, sanitizeFileName } from '../../src/modules/inbox/upload.service';
import { createLogger, setLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { customerText, mediaFixture, useInboxWorld } from '../helpers/inbox';
import { buildWebm, opusHeadBytes } from '../helpers/webm';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;

beforeEach(() => setRealtime(undefined));
afterEach(() => {
  setRealtime(undefined);
  vi.restoreAllMocks();
});

let users: Awaited<ReturnType<typeof world.setup>>['users'];
let conv: ConversationDoc;
let n = 0;
const CUSTOMER = () => `91900002${String(1000 + n).padStart(4, '0')}`;

/** A fresh account, number and a conversation with an open window. */
const fresh = async (customer?: string) => {
  n += 1;
  ({ users } = await world.setup());
  const from = customer ?? CUSTOMER();
  await world.deliver(customerText(state.channel, { from }));
  conv = (await ConversationModel.findOne({
    accountId: state.acc.account._id,
    waId: from,
  }).lean())!;
  world.jobs.sent.length = 0;
  return from;
};
const actor = () => ({ accountId: state.acc.account._id, userId: users.agent.user._id });
type Draft<T> = T extends unknown ? Omit<T, 'clientId'> & { clientId?: string } : never;
const send = (input: Draft<SendMessageInput>) =>
  sendMessage(state.ix, actor(), conv._id.toString(), {
    clientId: randomUUID(),
    ...input,
  });

/** Runs the recorded send jobs (waits / delays re-run immediately). */
const runSends = async (opts: { finalAttempt?: boolean } = {}) => {
  const outcomes = [];
  for (const job of world.jobs.sent.splice(0)) {
    if (job.name !== INBOX_JOBS.messageSend) continue;
    let waits = 0;
    for (;;) {
      const out = await processSend(state.ix, job.id, {
        finalAttempt: opts.finalAttempt ?? true,
        waits,
      });
      if (out.kind !== 'wait' && out.kind !== 'later') {
        outcomes.push(out);
        break;
      }
      waits += 1;
      if (waits > 30) throw new Error('stuck');
    }
  }
  return outcomes;
};
const reload = (m: MessageDoc) => MessageModel.findById(m._id).lean<MessageDoc>();
const upload = (
  kind: 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker',
  bytes: Buffer,
  declaredMime?: string,
  fileName?: string,
) => createUpload(state.ix, { ...actor(), kind, bytes, declaredMime, fileName });
const sent = () => world.w.fake.sentMessages(state.channel.phoneNumberId!);

describe('outbound — every type reaches Meta', () => {
  beforeEach(async () => {
    await fresh();
  });

  it('text, location, contacts, interactive (buttons / list / CTA), reply-to', async () => {
    const original = (await world.messagesOf({ direction: 'in' }))[0]!;
    const contact = await ContactModel.create({
      accountId: state.acc.account._id,
      phoneE164: '+919000000777',
      name: 'Ravi',
      source: { type: 'manual' },
    });
    const results = [
      await send({ type: 'text', text: 'Hello', replyToMessageId: original._id.toString() }),
      await send({ type: 'location', latitude: 26.9, longitude: 75.8, name: 'Office' }),
      await send({ type: 'contacts', contactIds: [contact._id.toString()] }),
      await send({
        type: 'buttons',
        body: 'Pay now?',
        footer: 'Thanks',
        header: { type: 'text', text: 'Due' },
        buttons: [
          { id: 'y', title: 'Yes' },
          { id: 'n', title: 'No' },
        ],
      }),
      await send({
        type: 'list',
        body: 'Pick',
        button: 'Plans',
        sections: [{ title: 'EMI', rows: [{ id: 'e3', title: '3 EMIs' }] }],
      }),
      await send({
        type: 'cta_url',
        body: 'Pay online',
        displayText: 'Pay',
        url: 'https://pay.example.com',
      }),
    ];
    expect(results.every((r) => r.created && r.message.status === 'queued')).toBe(true);
    expect(results[0]?.message.context?.replyToMessageId).toEqual(original._id);
    expect(results[2]?.message.contacts).toEqual([
      {
        name: 'Ravi',
        phones: [{ phone: '+919000000777', type: 'CELL', waId: null }],
        emails: [],
        org: null,
      },
    ]);
    const outcomes = await runSends();
    expect(outcomes.map((o) => o.kind)).toEqual(Array(6).fill('accepted'));
    const log = await sent();
    expect(log.map((s) => [s.type, s.interactiveType, s.replyTo])).toEqual([
      ['text', null, true],
      ['location', null, false],
      ['contacts', null, false],
      ['interactive', 'button', false],
      ['interactive', 'list', false],
      ['interactive', 'cta_url', false],
    ]);
    const stored = await reload(results[0]!.message);
    expect(stored).toMatchObject({ status: 'accepted', error: null });
    expect(stored?.waMessageId).toMatch(/^wamid\.FAKE/);
    expect(stored?.statusHistory.map((s) => s.status)).toEqual(['queued', 'accepted']);
    const row = await ConversationModel.findById(conv._id).lean();
    expect(row?.lastMessage).toMatchObject({ direction: 'out', status: 'accepted' });
  });

  it('media: image / video / audio / document / sticker uploaded to Meta once (retries reuse the id)', async () => {
    const img = await upload('image', mediaFixture('sample.jpg'), 'image/jpeg');
    const vid = await upload('video', mediaFixture('sample.mp4'), 'video/mp4');
    const aud = await upload('audio', mediaFixture('sample.ogg'), 'audio/ogg', 'clip.ogg');
    const doc = await upload(
      'document',
      mediaFixture('sample.pdf'),
      'application/pdf',
      '../../Statement Oct.pdf',
    );
    const stk = await upload('sticker', mediaFixture('sample.webp'), 'image/webp');
    const sentMsgs = [
      await send({ type: 'image', mediaToken: img._id.toString(), caption: 'Photo' }),
      await send({ type: 'video', mediaToken: vid._id.toString() }),
      await send({ type: 'audio', mediaToken: aud._id.toString() }),
      await send({ type: 'document', mediaToken: doc._id.toString(), caption: 'Your statement' }),
      await send({ type: 'sticker', mediaToken: stk._id.toString() }),
    ];
    // uploads consumed with the message
    expect(await InboxUploadModel.countDocuments({ accountId: state.acc.account._id })).toBe(0);
    expect(sentMsgs[3]?.message.media).toMatchObject({
      fileName: 'Statement Oct.pdf',
      status: 'ready',
      voice: false,
    });
    await runSends();
    const log = await sent();
    expect(log.map((s) => s.type)).toEqual(['image', 'video', 'audio', 'document', 'sticker']);
    expect(log.every((s) => s.mediaId?.startsWith('fake_media_'))).toBe(true);
    const stored = await reload(sentMsgs[0]!.message);
    expect(stored?.media).toMatchObject({ metaMediaId: log[0]?.mediaId });
    // a later re-send of the same stored file reuses the Meta id
    await MessageModel.updateOne({ _id: stored!._id }, { $set: { status: 'queued' } });
    const spy = vi.spyOn(world.w.fake, 'uploadMedia');
    await processSend(state.ix, stored!._id.toString(), { finalAttempt: true, waits: 0 });
    expect(spy).not.toHaveBeenCalled();
    // older than 29 days → uploaded again
    await MessageModel.updateOne(
      { _id: stored!._id },
      {
        $set: {
          status: 'queued',
          'media.metaMediaUploadedAt': new Date(Date.now() - 30 * 86_400_000),
        },
      },
    );
    await processSend(state.ix, stored!._id.toString(), { finalAttempt: true, waits: 0 });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('voice notes: browser WebM → OGG / Opus voice message; OGG as is; M4A → audio file', async () => {
    const webm = await upload('voice', buildWebm());
    expect(webm).toMatchObject({ kind: 'voice', mimeType: 'audio/ogg', voice: true });
    expect(webm.durationSec).toBeGreaterThan(1.9);
    expect(webm.storageKey).toMatch(/\/inbox-uploads\/[0-9a-f]{24}\.ogg$/);
    const r = await send({ type: 'voice', mediaToken: webm._id.toString() });
    expect(r.message).toMatchObject({
      type: 'audio',
      media: { voice: true, mimeType: 'audio/ogg' },
    });
    await runSends();
    expect((await sent()).at(-1)).toMatchObject({ type: 'audio', voiceValid: true });

    const m4a = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypM4A '),
      Buffer.alloc(12),
    ]);
    const fallback = await upload('voice', m4a);
    expect(fallback).toMatchObject({ voice: false, mimeType: 'audio/mp4' });
    // voice uploads can also go out as audio; audio uploads never as voice notes
    expect(
      (await send({ type: 'audio', mediaToken: fallback._id.toString() })).message.media?.voice,
    ).toBe(false);
    const plainAudio = await upload('audio', mediaFixture('sample.ogg'), 'audio/ogg');
    await expect(
      send({ type: 'voice', mediaToken: plainAudio._id.toString() }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('reactions (add / change / remove) on messages with a wamid ≤ 30 days old', async () => {
    const target = (await world.messagesOf({ direction: 'in' }))[0]!;
    const r = await send({ type: 'reaction', messageId: target._id.toString(), emoji: '👍' });
    expect(r.message).toMatchObject({
      type: 'reaction',
      reaction: { emoji: '👍', targetMessageId: target._id },
    });
    expect((await reload(target))?.reactions).toEqual([
      expect.objectContaining({ emoji: '👍', by: 'agent' }),
    ]);
    await send({ type: 'reaction', messageId: target._id.toString(), emoji: '' });
    expect((await reload(target))?.reactions).toEqual([]);
    await runSends();
    expect((await sent()).map((s) => s.type)).toEqual(['reaction', 'reaction']);
    // reactions don't move the list row
    expect((await ConversationModel.findById(conv._id).lean())?.lastMessage?.id).toEqual(
      target._id,
    );
    await MessageModel.updateOne(
      { _id: target._id },
      { $set: { at: new Date(Date.now() - 31 * 86_400_000) } },
    );
    await expect(
      send({ type: 'reaction', messageId: target._id.toString(), emoji: '❤️' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      send({ type: 'reaction', messageId: new Types.ObjectId().toString(), emoji: '❤️' }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('notes are stored for the team only: never queued, no window needed', async () => {
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { windowExpiresAt: new Date(Date.now() - 1000) } },
    );
    const r = await send({ type: 'note', text: 'Called him, will pay Friday' });
    expect(r.message).toMatchObject({
      type: 'note',
      status: 'sent',
      direction: 'out',
      origin: 'agent',
      waMessageId: null,
    });
    expect(world.jobs.sent).toEqual([]);
    expect(await runSends()).toEqual([]);
    // the list row is the customer's message, not the note
    expect((await ConversationModel.findById(conv._id).lean())?.lastMessage?.type).toBe('text');
  });
});

describe('outbound — rules', () => {
  beforeEach(async () => {
    await fresh();
  });

  it('window closed → 409 WHATSAPP_WINDOW_CLOSED; blocked → 409; channel not ready → 409; 404 for other accounts', async () => {
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { windowExpiresAt: new Date(Date.now() - 1000) } },
    );
    await expect(send({ type: 'text', text: 'Hi' })).rejects.toMatchObject({
      code: 'WHATSAPP_WINDOW_CLOSED',
      details: [{ path: 'windowExpiresAt' }],
    });
    await ConversationModel.updateOne({ _id: conv._id }, { $set: { windowExpiresAt: null } });
    await expect(send({ type: 'text', text: 'Hi' })).rejects.toMatchObject({
      code: 'WHATSAPP_WINDOW_CLOSED',
      details: [{ message: 'The customer has not written yet' }],
    });
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { windowExpiresAt: new Date(Date.now() + 3_600_000), blocked: true } },
    );
    await expect(send({ type: 'text', text: 'Hi' })).rejects.toMatchObject({
      code: 'WHATSAPP_RECIPIENT_BLOCKED',
    });
    await ConversationModel.updateOne({ _id: conv._id }, { $set: { blocked: false } });
    for (const status of ['needs_reconnect', 'action_needed', 'disconnected']) {
      await WhatsAppChannelModel.updateOne({ _id: state.channel._id }, { $set: { status } });
      await expect(send({ type: 'text', text: 'Hi' })).rejects.toMatchObject({
        code: 'WHATSAPP_CHANNEL_NOT_READY',
      });
    }
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { status: 'restricted' } },
    );
    expect((await send({ type: 'text', text: 'Meta decides' })).created).toBe(true);
    await expect(
      sendMessage(state.ix, { ...actor(), accountId: new Types.ObjectId() }, conv._id.toString(), {
        clientId: randomUUID(),
        type: 'text',
        text: 'x',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('opted-out customers can be answered inside the window they opened', async () => {
    await ContactModel.updateOne({ _id: conv.contactId }, { $set: { optedOutAt: new Date() } });
    expect((await send({ type: 'text', text: 'Noted, no more reminders' })).created).toBe(true);
  });

  it('idempotent by clientId (also in parallel): one message, one Meta call; reused id elsewhere → 409', async () => {
    const clientId = randomUUID();
    const [a, b] = await Promise.all([
      send({ type: 'text', text: 'Once', clientId }),
      send({ type: 'text', text: 'Once', clientId }),
    ]);
    expect(a.message._id).toEqual(b.message._id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const again = await send({ type: 'text', text: 'Once', clientId });
    expect(again).toMatchObject({ created: false });
    await runSends();
    expect(await sent()).toHaveLength(1);
    const noteId = randomUUID();
    await Promise.all([
      send({ type: 'note', text: 'n', clientId: noteId }),
      send({ type: 'note', text: 'n', clientId: noteId }),
    ]);
    expect(await MessageModel.countDocuments({ clientId: noteId })).toBe(1);
    // the same client id in another conversation
    const other = await ConversationModel.create({
      accountId: state.acc.account._id,
      channelId: state.channel._id,
      contactId: conv.contactId,
      waId: '919000099999',
      phoneE164: '+919000099999',
      source: 'outbound',
    });
    await expect(
      sendMessage(state.ix, actor(), other._id.toString(), { clientId, type: 'text', text: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFLICT_DUPLICATE' });
  });

  it('uploads belong to their user, expire, match their kind and are used once', async () => {
    const img = await upload('image', mediaFixture('sample.jpg'), 'image/jpeg');
    await expect(
      sendMessage(state.ix, { ...actor(), userId: users.owner.user._id }, conv._id.toString(), {
        clientId: randomUUID(),
        type: 'image',
        mediaToken: img._id.toString(),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(send({ type: 'video', mediaToken: img._id.toString() })).rejects.toMatchObject({
      details: [{ path: 'mediaToken', message: 'The upload is a image' }],
    });
    await send({ type: 'image', mediaToken: img._id.toString() });
    await expect(send({ type: 'image', mediaToken: img._id.toString() })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    const old = await upload('image', mediaFixture('sample.png'), 'image/png');
    await InboxUploadModel.updateOne(
      { _id: old._id },
      { $set: { expiresAt: new Date(Date.now() - 1) } },
    );
    await expect(send({ type: 'image', mediaToken: old._id.toString() })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // a header image for interactive buttons
    const header = await upload('image', mediaFixture('sample.jpg'), 'image/jpeg');
    const r = await send({
      type: 'buttons',
      body: 'B',
      header: { type: 'image', mediaToken: header._id.toString() },
      buttons: [{ id: 'a', title: 'A' }],
    });
    expect(r.message.interactive?.header).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    await runSends();
    expect((await sent()).at(-1)).toMatchObject({ type: 'interactive', interactiveType: 'button' });
    await expect(
      send({ type: 'contacts', contactIds: [new Types.ObjectId().toString()] }),
    ).rejects.toMatchObject({
      details: [{ path: 'contactIds' }],
    });
    await expect(
      send({ type: 'text', text: 'x', replyToMessageId: new Types.ObjectId().toString() }),
    ).rejects.toMatchObject({
      details: [{ path: 'replyToMessageId' }],
    });
  });

  it('a closed conversation reopens when the agent sends', async () => {
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { status: 'closed', closedAt: new Date() } },
    );
    await send({ type: 'text', text: 'Back' });
    expect((await ConversationModel.findById(conv._id).lean())?.status).toBe('open');
  });
});

describe('send job — errors, retries, order, restarts', () => {
  beforeEach(async () => {
    await fresh();
  });

  it('retryable errors are thrown until the last attempt, then failed with our reason', async () => {
    const r = await send({ type: 'text', text: 'Hi' });
    world.w.fake.failNext(
      'sendMessage',
      graphError(400, { error: { code: 131000, message: 'x' } }),
    );
    await expect(
      processSend(state.ix, r.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).rejects.toMatchObject({
      name: 'RetryableSendError',
    });
    expect((await reload(r.message))?.status).toBe('queued');
    world.w.fake.failNext(
      'sendMessage',
      graphError(400, { error: { code: 131000, message: 'x' } }),
    );
    expect(
      await processSend(state.ix, r.message._id.toString(), { finalAttempt: true, waits: 0 }),
    ).toEqual({
      kind: 'failed',
      reason: 'WhatsApp service temporarily unavailable',
    });
    expect(await reload(r.message)).toMatchObject({ status: 'failed', error: { code: 131000 } });
  });

  it('knobs: window closed at Meta (131047), throughput (retry), 131056 waits 60 s, 190 → reconnect', async () => {
    const from = await fresh('919000000007');
    void from;
    const r = await send({ type: 'text', text: 'Hi' });
    expect(await runSends()).toEqual([
      { kind: 'failed', reason: 'More than 24 hours have passed since the customer last replied' },
    ]);
    expect((await reload(r.message))?.error).toMatchObject({ code: 131047 });

    await fresh('919000000006');
    const t = await send({ type: 'text', text: 'Hi' });
    await expect(
      processSend(state.ix, t.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).rejects.toThrow();
    await expect(
      processSend(state.ix, t.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).rejects.toThrow();
    expect(
      await processSend(state.ix, t.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).toMatchObject({ kind: 'accepted' });

    await fresh();
    const p = await send({ type: 'text', text: 'Hi' });
    world.w.fake.failNext(
      'sendMessage',
      graphError(400, { error: { code: 131056, message: 'pair' } }),
    );
    expect(
      await processSend(state.ix, p.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).toEqual({ kind: 'later', delayMs: 60_000 });
    expect((await reload(p.message))?.status).toBe('queued');

    await world.w.fake.revokeToken(state.token);
    expect(
      await processSend(state.ix, p.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).toEqual({
      kind: 'failed',
      reason: 'Connection to WhatsApp expired',
    });
    expect((await WhatsAppChannelModel.findById(state.channel._id).lean())?.status).toBe(
      'needs_reconnect',
    );
  });

  it('restart safety: accepted / failed messages are never sent again; missing number / file / conversation fail', async () => {
    const r = await send({ type: 'text', text: 'Hi' });
    await runSends();
    expect(
      await processSend(state.ix, r.message._id.toString(), { finalAttempt: true, waits: 0 }),
    ).toEqual({ kind: 'skipped' });
    expect(await sent()).toHaveLength(1);
    expect(
      await processSend(state.ix, new Types.ObjectId().toString(), {
        finalAttempt: true,
        waits: 0,
      }),
    ).toEqual({ kind: 'skipped' });

    const img = await upload('image', mediaFixture('sample.jpg'), 'image/jpeg');
    const m = await send({ type: 'image', mediaToken: img._id.toString() });
    await world.storage.delete(m.message.media!.storageKey!);
    expect(await runSends()).toEqual([{ kind: 'failed', reason: 'The file is missing' }]);

    const x = await send({ type: 'text', text: 'Hi' });
    await ConversationModel.updateOne({ _id: conv._id }, { $set: { blocked: true } });
    expect(await runSends()).toEqual([{ kind: 'failed', reason: 'You blocked this customer' }]);
    void x;
    await ConversationModel.updateOne({ _id: conv._id }, { $set: { blocked: false } });
    const y = await send({ type: 'text', text: 'Hi' });
    await WhatsAppChannelModel.updateOne(
      { _id: state.channel._id },
      { $set: { status: 'disconnected' } },
    );
    expect(await runSends()).toEqual([
      { kind: 'failed', reason: 'The WhatsApp number is not connected' },
    ]);
    void y;
  });

  it('outgoing order per conversation: a later message waits for an earlier queued one', async () => {
    const first = await send({ type: 'text', text: 'First' });
    const second = await send({ type: 'text', text: 'Second' });
    expect(
      await processSend(state.ix, second.message._id.toString(), { finalAttempt: true, waits: 0 }),
    ).toEqual({ kind: 'wait', delayMs: 500 });
    await processSend(state.ix, first.message._id.toString(), { finalAttempt: true, waits: 0 });
    expect(
      await processSend(state.ix, second.message._id.toString(), { finalAttempt: true, waits: 1 }),
    ).toMatchObject({ kind: 'accepted' });
    // after 20 waits it sends anyway
    const a = await send({ type: 'text', text: 'A' });
    const b = await send({ type: 'text', text: 'B' });
    expect(
      await processSend(state.ix, b.message._id.toString(), { finalAttempt: true, waits: 20 }),
    ).toMatchObject({ kind: 'accepted' });
    void a;
    expect((await sent()).map((s) => s.type)).toEqual(['text', 'text', 'text']);
  });

  it('non-Meta errors: validation fails at once, others rethrow until the last attempt', async () => {
    const r = await send({ type: 'text', text: 'Hi' });
    await MessageModel.updateOne({ _id: r.message._id }, { $set: { text: '' } }); // builder refuses
    expect(
      await processSend(state.ix, r.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).toEqual({ kind: 'failed', reason: 'Message failed' });
    const s = await send({ type: 'text', text: 'Hi' });
    vi.spyOn(world.w.fake, 'sendMessage').mockRejectedValueOnce(new TypeError('boom'));
    await expect(
      processSend(state.ix, s.message._id.toString(), { finalAttempt: false, waits: 0 }),
    ).rejects.toThrow('boom');
    vi.spyOn(world.w.fake, 'sendMessage').mockRejectedValueOnce(new TypeError('boom'));
    expect(
      await processSend(state.ix, s.message._id.toString(), { finalAttempt: true, waits: 0 }),
    ).toMatchObject({ kind: 'failed' });
  });

  it('worker: delays the job without using an attempt (DelayedError), returns outcomes', async () => {
    const first = await send({ type: 'text', text: 'First' });
    const second = await send({ type: 'text', text: 'Second' });
    const run = processWhatsAppJob({ ctx: world.w.ctx, service: world.w.svc }, state.ix);
    const moveToDelayed = vi.fn(() => Promise.resolve());
    const updateData = vi.fn(() => Promise.resolve());
    const job = (id: string, data: Record<string, unknown> = {}) =>
      ({
        name: INBOX_JOBS.messageSend,
        data: { messageId: id, ...data },
        attemptsMade: 0,
        opts: { attempts: 5 },
        moveToDelayed,
        updateData,
      }) as unknown as Job;
    await expect(run(job(second.message._id.toString()), 'tok')).rejects.toMatchObject({
      name: 'DelayedError',
    });
    expect(updateData).toHaveBeenCalledWith({ messageId: second.message._id.toString(), waits: 1 });
    expect(moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(await run(job(first.message._id.toString()))).toMatchObject({ kind: 'accepted' });
    const inbound = (await world.messagesOf({ direction: 'in' }))[0]!;
    expect(
      await run({
        name: INBOX_JOBS.readReceipt,
        data: { messageId: inbound._id.toString() },
        attemptsMade: 0,
        opts: { attempts: 3 },
      } as unknown as Job),
    ).toEqual({ status: 'sent' });
  });
});

describe('retry endpoint', () => {
  beforeEach(async () => {
    await fresh();
  });

  it('a failed message is sent again as a new message (retryOf); only failed ones; window re-checked', async () => {
    const r = await send({ type: 'text', text: 'Hi' });
    world.w.fake.failNext(
      'sendMessage',
      graphError(400, { error: { code: 131026, message: 'x' } }),
    );
    await runSends();
    const retried = await retryMessage(state.ix, actor(), r.message._id.toString());
    expect(retried).toMatchObject({
      status: 'queued',
      retryOf: r.message._id,
      text: 'Hi',
      error: null,
      waMessageId: null,
    });
    expect(retried.clientId).not.toBe(r.message.clientId);
    // twice → the same retry
    expect((await retryMessage(state.ix, actor(), r.message._id.toString()))._id).toEqual(
      retried._id,
    );
    await runSends();
    expect((await reload(retried))?.status).toBe('accepted');
    await expect(retryMessage(state.ix, actor(), retried._id.toString())).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    await expect(
      retryMessage(state.ix, actor(), new Types.ObjectId().toString()),
    ).rejects.toMatchObject({ status: 404 });
    await MessageModel.updateOne({ _id: retried._id }, { $set: { status: 'failed' } });
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { windowExpiresAt: new Date(Date.now() - 1) } },
    );
    await expect(retryMessage(state.ix, actor(), retried._id.toString())).rejects.toMatchObject({
      code: 'WHATSAPP_WINDOW_CLOSED',
    });
  });
});

describe('uploads — sniffing, limits, names', () => {
  beforeEach(async () => {
    await fresh();
  });

  it('type mismatch / not allowed / too large / empty; documents keep a safe name', async () => {
    await expect(
      upload('document', mediaFixture('sample.png'), 'application/pdf'),
    ).rejects.toMatchObject({
      code: 'WHATSAPP_MEDIA_INVALID',
      details: [{ message: 'type_mismatch' }],
    });
    await expect(upload('image', mediaFixture('sample.pdf'), 'image/png')).rejects.toMatchObject({
      details: [{ message: 'type_mismatch' }],
    });
    await expect(
      upload('image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'),
    ).rejects.toMatchObject({
      details: [{ message: 'type_mismatch' }],
    });
    await expect(
      upload('image', Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]), 'image/gif'),
    ).rejects.toMatchObject({
      details: [{ message: 'not_allowed' }],
    });
    await expect(
      upload('image', Buffer.concat([mediaFixture('sample.jpg'), Buffer.alloc(5 * 1024 * 1024)])),
    ).rejects.toMatchObject({
      code: 'WHATSAPP_MEDIA_TOO_LARGE',
      details: [{ message: `At most ${String(5 * 1024 * 1024)} bytes` }],
    });
    await expect(
      upload('sticker', Buffer.concat([mediaFixture('sample.webp'), Buffer.alloc(100 * 1024)])),
    ).rejects.toMatchObject({
      code: 'WHATSAPP_MEDIA_TOO_LARGE',
    });
    await expect(upload('image', Buffer.alloc(0))).rejects.toMatchObject({
      details: [{ message: 'corrupt' }],
    });
    await expect(upload('image', mediaFixture('sample.jpg'), 'video/mp4')).rejects.toMatchObject({
      details: [{ message: 'type_mismatch' }],
    });
    const doc = await upload(
      'document',
      mediaFixture('sample.pdf'),
      'application/pdf',
      'C:\\Users\\x\\Bill<1>.pdf',
    );
    expect(doc).toMatchObject({
      fileName: 'Bill1.pdf',
      mimeType: 'application/pdf',
      voice: false,
      durationSec: null,
    });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await world.storage.exists(doc.storageKey)).toBe(true);
    const img = await upload('image', mediaFixture('sample.jpg'), 'image/jpeg', 'photo.jpg');
    expect(img.fileName).toBeNull();
  });

  it('voice uploads: stereo / corrupt / too short / unsupported → 422 with the reason', async () => {
    await expect(
      upload('voice', buildWebm({ codecPrivate: opusHeadBytes(2) })),
    ).rejects.toMatchObject({ details: [{ message: 'stereo_voice' }] });
    await expect(upload('voice', buildWebm().subarray(0, 200))).rejects.toMatchObject({
      details: [{ message: 'corrupt' }],
    });
    await expect(
      upload('voice', buildWebm({ packets: [Buffer.from([0xf8, 1])] })),
    ).rejects.toMatchObject({ details: [{ message: 'too_short' }] });
    await expect(upload('voice', mediaFixture('sample.jpg'))).rejects.toMatchObject({
      details: [{ message: 'not_allowed' }],
    });
    const ogg = await upload('voice', mediaFixture('sample.ogg'));
    expect(ogg).toMatchObject({ voice: true, durationSec: 1 });
  });

  it('sanitizeFileName', () => {
    expect(sanitizeFileName('../../etc/passwd', 'pdf')).toBe('passwd');
    expect(sanitizeFileName(null, 'pdf')).toBe('file.pdf');
    expect(sanitizeFileName('..', 'pdf')).toBe('file.pdf');
    expect(sanitizeFileName('a\u0000b\u001f c', 'txt')).toBe('ab c');
    const long = sanitizeFileName(`${'x'.repeat(300)}.xlsx`, 'xlsx');
    expect(long).toHaveLength(200);
    expect(long.endsWith('.xlsx')).toBe(true);
    expect(sanitizeFileName('y'.repeat(300), 'pdf')).toHaveLength(200);
  });
});

describe('outbound.schema — validation per field', () => {
  const parse = (body: Record<string, unknown>) =>
    SendMessageBody.safeParse({ clientId: randomUUID(), ...body });
  it('rejects each limit', () => {
    expect(parse({ type: 'text', text: '' }).success).toBe(false);
    expect(parse({ type: 'text', text: 'x'.repeat(4097) }).success).toBe(false);
    expect(parse({ type: 'text', text: 'ok', clientId: 'not-a-uuid' }).success).toBe(false);
    expect(parse({ type: 'image', mediaToken: 'x' }).success).toBe(false);
    expect(
      parse({ type: 'image', mediaToken: 'a'.repeat(24), caption: 'x'.repeat(1025) }).success,
    ).toBe(false);
    expect(parse({ type: 'location', latitude: 91, longitude: 0 }).success).toBe(false);
    expect(parse({ type: 'contacts', contactIds: [] }).success).toBe(false);
    expect(parse({ type: 'contacts', contactIds: Array(11).fill('a'.repeat(24)) }).success).toBe(
      false,
    );
    const btn = (k: number) =>
      Array.from({ length: k }, (_, i) => ({ id: `b${String(i)}`, title: 'T' }));
    expect(parse({ type: 'buttons', body: 'B', buttons: btn(4) }).success).toBe(false);
    expect(
      parse({
        type: 'buttons',
        body: 'B',
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'a', title: 'B' },
        ],
      }).success,
    ).toBe(false);
    expect(
      parse({ type: 'buttons', body: 'B', buttons: [{ id: 'a', title: 'x'.repeat(21) }] }).success,
    ).toBe(false);
    expect(
      parse({ type: 'list', body: 'B', button: 'Go', sections: [{ rows: btn(11) }] }).success,
    ).toBe(false);
    expect(
      parse({
        type: 'list',
        body: 'B',
        button: 'Go',
        sections: [{ rows: [{ id: 'r', title: 'R' }] }, { rows: [{ id: 'r', title: 'S' }] }],
      }).success,
    ).toBe(false);
    expect(
      parse({ type: 'cta_url', body: 'B', displayText: 'Go', url: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      parse({ type: 'cta_url', body: 'B', displayText: 'Go', url: 'http://x.example' }).success,
    ).toBe(false);
    expect(
      parse({ type: 'reaction', messageId: 'a'.repeat(24), emoji: '👍'.repeat(9) }).success,
    ).toBe(false);
    expect(parse({ type: 'gif', url: 'x' }).success).toBe(false);
    // and accepts good ones
    expect(parse({ type: 'reaction', messageId: 'a'.repeat(24), emoji: '' }).success).toBe(true);
    expect(parse({ type: 'note', text: 'Internal' }).success).toBe(true);
    expect(
      parse({
        type: 'buttons',
        body: 'B',
        header: { type: 'document', mediaToken: 'a'.repeat(24) },
        buttons: btn(3),
      }).success,
    ).toBe(true);
  });
});

describe('read receipts, unread, typing', () => {
  beforeEach(async () => {
    await fresh();
  });

  it('read → unread 0 + a receipt job for the latest customer message; impersonators change nothing; setting off → no job', async () => {
    const latest = (await world.messagesOf({ direction: 'in' })).at(-1)!;
    const imp = await markConversationRead(state.ix, {
      ...actor(),
      conversationId: conv._id.toString(),
      impersonating: true,
    });
    expect(imp.unreadCount).toBe(1);
    expect(world.jobs.sent).toEqual([]);
    const read = await markConversationRead(state.ix, {
      ...actor(),
      conversationId: conv._id.toString(),
      impersonating: false,
    });
    expect(read).toMatchObject({ unreadCount: 0, lastReadBy: users.agent.user._id });
    expect(world.jobs.sent).toEqual([{ name: INBOX_JOBS.readReceipt, id: latest._id.toString() }]);
    expect(await processReadReceipt(state.ix, latest._id.toString(), { finalAttempt: true })).toBe(
      'sent',
    );
    expect(await world.w.fake.readReceipts(state.channel.phoneNumberId!)).toEqual([
      expect.objectContaining({ waMessageId: latest.waMessageId, typing: false }),
    ]);
    world.jobs.sent.length = 0;
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.inbox.sendReadReceipts': false } },
    );
    await markConversationRead(state.ix, {
      ...actor(),
      conversationId: conv._id.toString(),
      impersonating: false,
    });
    expect(world.jobs.sent).toEqual([]);
    const unread = await markConversationUnread({
      accountId: state.acc.account._id,
      conversationId: conv._id.toString(),
    });
    expect(unread.unreadCount).toBe(1);
    await expect(
      markConversationUnread({
        accountId: new Types.ObjectId(),
        conversationId: conv._id.toString(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('receipt job: skips odd ids / disconnected numbers; retries transient errors; token revoked → reconnect', async () => {
    const latest = (await world.messagesOf({ direction: 'in' })).at(-1)!;
    expect(
      await processReadReceipt(state.ix, new Types.ObjectId().toString(), { finalAttempt: true }),
    ).toBe('skipped');
    world.w.fake.failNext('markRead');
    await expect(
      processReadReceipt(state.ix, latest._id.toString(), { finalAttempt: false }),
    ).rejects.toBeTruthy();
    world.w.fake.failNext('markRead');
    expect(await processReadReceipt(state.ix, latest._id.toString(), { finalAttempt: true })).toBe(
      'skipped',
    );
    await world.w.fake.revokeToken(state.token);
    expect(await processReadReceipt(state.ix, latest._id.toString(), { finalAttempt: true })).toBe(
      'skipped',
    );
    expect((await WhatsAppChannelModel.findById(state.channel._id).lean())?.status).toBe(
      'needs_reconnect',
    );
    expect(await processReadReceipt(state.ix, latest._id.toString(), { finalAttempt: true })).toBe(
      'skipped',
    );
  });

  it('typing: throttled per conversation, topic event, Meta indicator only inside the window with receipts on', async () => {
    const topic: unknown[] = [];
    setRealtime({
      pushToAccount: () => Promise.resolve(),
      pushToTopic: (_t: string, type: string, data: unknown) => (
        topic.push({ type, data }),
        Promise.resolve()
      ),
    } as never);
    const user = { id: users.agent.user._id.toString(), name: 'Asha' };
    expect(
      await sendTyping(state.ix, {
        accountId: state.acc.account._id,
        user,
        conversationId: conv._id.toString(),
      }),
    ).toEqual({ sent: true });
    expect(
      await sendTyping(state.ix, {
        accountId: state.acc.account._id,
        user,
        conversationId: conv._id.toString(),
      }),
    ).toEqual({ sent: false });
    expect(topic).toEqual([
      {
        type: 'inbox.typing',
        data: { conversationId: conv._id.toString(), userId: user.id, name: 'Asha' },
      },
    ]);
    expect((await world.w.fake.readReceipts(state.channel.phoneNumberId!)).at(-1)).toMatchObject({
      typing: true,
    });
    await world.w.redis.del(`inbox-typing-${conv._id.toString()}`);
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.inbox.sendReadReceipts': false } },
    );
    expect(
      await sendTyping(state.ix, {
        accountId: state.acc.account._id,
        user,
        conversationId: conv._id.toString(),
      }),
    ).toEqual({ sent: false });
    await world.w.redis.del(`inbox-typing-${conv._id.toString()}`);
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { windowExpiresAt: new Date(Date.now() - 1) } },
    );
    expect(
      await sendTyping(state.ix, {
        accountId: state.acc.account._id,
        user,
        conversationId: conv._id.toString(),
      }),
    ).toEqual({ sent: false });
    await world.w.redis.del(`inbox-typing-${conv._id.toString()}`);
    await AccountModel.updateOne(
      { _id: state.acc.account._id },
      { $set: { 'settings.inbox.sendReadReceipts': true } },
    );
    await ConversationModel.updateOne(
      { _id: conv._id },
      { $set: { windowExpiresAt: new Date(Date.now() + 3_600_000) } },
    );
    world.w.fake.failNext('markRead');
    expect(
      await sendTyping(state.ix, {
        accountId: state.acc.account._id,
        user,
        conversationId: conv._id.toString(),
      }),
    ).toEqual({ sent: false });
    await expect(
      sendTyping(state.ix, {
        accountId: new Types.ObjectId(),
        user,
        conversationId: conv._id.toString(),
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('retention (owner decision: 90 days)', () => {
  beforeEach(async () => {
    // the job is platform-wide: start from an empty inbox
    await MessageModel.deleteMany({});
    await InboxUploadModel.deleteMany({});
    await fresh();
  });

  it('deletes older messages + files, recomputes rows, keeps newer data / other accounts; orphan uploads; audit; 0 keeps', async () => {
    const img = await upload('image', mediaFixture('sample.jpg'), 'image/jpeg');
    const oldMsg = await send({ type: 'image', mediaToken: img._id.toString() });
    const keep = await send({ type: 'text', text: 'Recent' });
    const day = 86_400_000;
    await MessageModel.updateOne(
      { _id: oldMsg.message._id },
      { $set: { at: new Date(Date.now() - 91 * day) } },
    );
    await MessageModel.updateMany(
      { conversationId: conv._id, direction: 'in' },
      { $set: { at: new Date(Date.now() - 91 * day) } },
    );
    const orphan = await upload('document', mediaFixture('sample.pdf'), 'application/pdf');
    await InboxUploadModel.updateOne(
      { _id: orphan._id },
      { $set: { expiresAt: new Date(Date.now() - 1) } },
    );
    const live = await upload('document', mediaFixture('sample.pdf'), 'application/pdf');

    expect(await runInboxRetention(world.storage, 0)).toMatchObject({ messages: 0, uploads: 1 });
    expect(await MessageModel.countDocuments({ conversationId: conv._id })).toBe(3);

    const res = await runInboxRetention(world.storage, 90);
    expect(res).toMatchObject({ messages: 2, media: 1, conversations: 1 });
    expect(await MessageModel.findById(keep.message._id).lean()).not.toBeNull();
    expect(await world.storage.exists(oldMsg.message.media!.storageKey!)).toBe(false);
    expect(await world.storage.exists(orphan.storageKey)).toBe(false);
    expect(await InboxUploadModel.findById(live._id).lean()).not.toBeNull();
    const row = await ConversationModel.findById(conv._id).lean();
    expect(row?.lastMessage?.preview).toBe('Recent');
    const audit = await AuditLogModel.findOne({
      accountId: state.acc.account._id,
      action: 'inbox.messages_purged',
    })
      .sort({ at: -1 })
      .lean();
    expect(audit?.meta).toMatchObject({ messages: 2, media: 1 });
    // everything gone → row cleared, unread 0; the conversation stays
    await MessageModel.updateMany(
      { conversationId: conv._id },
      { $set: { at: new Date(Date.now() - 100 * day) } },
    );
    await runInboxRetention(world.storage, 90);
    expect(await ConversationModel.findById(conv._id).lean()).toMatchObject({
      lastMessage: null,
      unreadCount: 0,
    });
  });

  it('the maintenance worker runs it daily (needs storage)', async () => {
    const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const job = { name: INBOX_RETENTION_JOB, data: {} } as Job;
    expect(await processMaintenanceJob({ logger, storage: world.storage })(job)).toMatchObject({
      messages: 0,
    });
    await expect(processMaintenanceJob({ logger })(job)).rejects.toThrow('needs file storage');
    expect(MAINTENANCE_SCHEDULES).toContainEqual({
      name: 'inbox-retention',
      pattern: '50 5 * * *',
    });
  });
});

describe('logs never carry customer data', () => {
  it('a full send run of every type logs ids / codes only', async () => {
    const lines: string[] = [];
    setLogger(
      createLogger(
        { NODE_ENV: 'test', LOG_LEVEL: 'trace' },
        new Writable({ write: (c: Buffer, _e, done) => (lines.push(c.toString()), done()) }),
      ),
    );
    try {
      await fresh();
      const doc = await upload(
        'document',
        mediaFixture('sample.pdf'),
        'application/pdf',
        'Secret Statement.pdf',
      );
      await send({
        type: 'document',
        mediaToken: doc._id.toString(),
        caption: 'Your private statement',
      });
      await send({ type: 'text', text: 'Pay Rs 5000 by Friday' });
      world.w.fake.failNext(
        'sendMessage',
        graphError(400, { error: { code: 131026, message: 'Pay Rs 5000' } }),
      );
      await runSends();
      const logs = lines.join('\n');
      for (const leak of [
        'Secret Statement',
        'private statement',
        'Pay Rs 5000',
        conv.waId,
        state.token,
      ]) {
        expect(logs, leak).not.toContain(leak);
      }
    } finally {
      setLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    }
  });
});
