import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel, DEFAULT_INBOX_SETTINGS } from '../../src/db/models/account.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { InboxUploadModel } from '../../src/db/models/inbox-upload.model';
import { MessageModel } from '../../src/db/models/message.model';
import { useTestDb } from '../helpers/db';

useTestDb();

beforeAll(async () => {
  await ConversationModel.createIndexes();
  await MessageModel.createIndexes();
  await InboxUploadModel.createIndexes();
});

const ids = () => ({
  accountId: new Types.ObjectId(),
  channelId: new Types.ObjectId(),
  contactId: new Types.ObjectId(),
});

const conversation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...ids(),
  waId: '919000099001',
  phoneE164: '+919000099001',
  source: 'inbound',
  ...over,
});

const message = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...ids(),
  conversationId: new Types.ObjectId(),
  direction: 'in',
  origin: 'customer',
  type: 'text',
  text: 'Test message',
  status: 'received',
  at: new Date('2026-10-23T10:00:00Z'),
  ...over,
});

describe('Conversation model', () => {
  it('defaults and validation', async () => {
    const doc = await ConversationModel.create(conversation());
    expect(doc.toObject()).toMatchObject({
      status: 'open',
      assignedTo: null,
      unreadCount: 0,
      lastMessage: null,
      lastInboundAt: null,
      windowExpiresAt: null,
      blocked: false,
      profileName: null,
      closedAt: null,
    });
    await expect(ConversationModel.create(conversation({ waId: '+91 9000' }))).rejects.toThrow();
    await expect(ConversationModel.create(conversation({ status: 'pending' }))).rejects.toThrow();
    await expect(ConversationModel.create(conversation({ source: 'sms' }))).rejects.toThrow();
    await expect(ConversationModel.create(conversation({ unreadCount: -1 }))).rejects.toThrow();
    await expect(
      ConversationModel.create(conversation({ accountId: undefined })),
    ).rejects.toThrow();
  });

  it('one conversation per account × number × customer', async () => {
    const base = conversation({ waId: '919000099002' });
    await ConversationModel.create(base);
    await expect(ConversationModel.create({ ...base })).rejects.toMatchObject({ code: 11000 });
    await ConversationModel.create({ ...base, channelId: new Types.ObjectId() });
    await ConversationModel.create({ ...base, accountId: new Types.ObjectId() });
  });

  it('lastMessage keeps its declared fields and validates them', async () => {
    const id = new Types.ObjectId();
    const at = new Date('2026-10-23T10:00:00Z');
    const doc = await ConversationModel.create(
      conversation({
        waId: '919000099003',
        lastMessage: { id, direction: 'out', type: 'image', preview: 'Photo', at, status: 'sent' },
      }),
    );
    const read = await ConversationModel.findById(doc._id).lean();
    expect(read?.lastMessage).toEqual({
      id,
      direction: 'out',
      type: 'image',
      preview: 'Photo',
      at,
      status: 'sent',
    });
    await expect(
      ConversationModel.create(
        conversation({
          waId: '919000099004',
          lastMessage: {
            id,
            direction: 'out',
            type: 'image',
            preview: 'x'.repeat(121),
            at,
            status: 'sent',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('declares the list / filter indexes', async () => {
    const keys = (await ConversationModel.collection.indexes()).map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        { accountId: 1, channelId: 1, waId: 1 },
        { accountId: 1, status: 1, 'lastMessage.at': -1, _id: -1 },
        { accountId: 1, assignedTo: 1, status: 1, 'lastMessage.at': -1 },
        { accountId: 1, unreadCount: 1 },
        { accountId: 1, contactId: 1 },
      ]),
    );
  });
});

describe('Message model', () => {
  it('defaults for a plain text message', async () => {
    const doc = await MessageModel.create(message());
    expect(doc.toObject()).toMatchObject({
      media: null,
      location: null,
      contacts: null,
      interactive: null,
      reaction: null,
      context: null,
      reactions: [],
      order: null,
      button: null,
      system: null,
      statusHistory: [],
      error: null,
      waMessageId: null,
      clientId: null,
      sentBy: null,
      retryOf: null,
      pricing: null,
      metaTimestamp: null,
    });
  });

  it('every declared sub-document round-trips unchanged (strict mode drops nothing)', async () => {
    const targetMessageId = new Types.ObjectId();
    const replyToMessageId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    const at = new Date('2026-10-23T10:05:00Z');
    const full = {
      media: {
        metaMediaId: 'fake_media_1',
        metaMediaUploadedAt: at,
        storageKey: 'accounts/a/inbox-media/m.ogg',
        mimeType: 'audio/ogg',
        size: 2048,
        sha256: 'abc',
        fileName: 'note.ogg',
        voice: true,
        durationSec: 3,
        animated: false,
        status: 'ready',
        error: null,
      },
      location: { latitude: 26.9, longitude: 75.8, name: 'Office', address: 'Jaipur', url: null },
      contacts: [
        {
          name: 'Test Customer',
          phones: [{ phone: '+91 90000 99009', type: 'CELL', waId: '919000099009' }],
          emails: [{ email: 'test@example.com', type: 'WORK' }],
          org: 'Test Org',
        },
      ],
      interactive: {
        kind: 'list',
        header: {
          type: 'text',
          text: 'Header',
          storageKey: null,
          metaMediaId: null,
          mimeType: null,
          fileName: null,
        },
        body: 'Pick one',
        footer: 'Footer',
        buttons: [{ id: 'b1', title: 'Yes' }],
        listButton: 'Options',
        sections: [{ title: 'Section', rows: [{ id: 'r1', title: 'Row', description: 'Desc' }] }],
        cta: { displayText: 'Open', url: 'https://example.com' },
        reply: { id: 'r1', title: 'Row', description: 'Desc' },
        nfmResponse: '{"a":1}',
        nfmTruncated: false,
      },
      reaction: { targetWaMessageId: 'wamid.T', targetMessageId, emoji: '👍' },
      context: {
        replyToWaMessageId: 'wamid.R',
        replyToMessageId,
        forwarded: true,
        frequentlyForwarded: false,
        referral: {
          sourceUrl: 'https://fb.me/ad',
          sourceType: 'ad',
          sourceId: 'ad1',
          headline: 'Headline',
          body: 'Body',
          ctwaClid: 'clid',
        },
      },
      reactions: [{ emoji: '❤️', by: 'agent', userId, at }],
      order: { catalogId: 'cat1', itemsCount: 2, total: 500, currency: 'INR' },
      button: { payload: 'p1', text: 'Tap' },
      system: { kind: 'customer_changed_number', newWaIdLast4: '1234' },
      statusHistory: [{ status: 'sent', at }],
      error: { code: 131026, title: 'Undeliverable', reason: 'Message undeliverable' },
      pricing: {
        billable: false,
        model: 'PMP',
        category: 'service',
        type: 'free_customer_service',
        conversationId: 'conv1',
        conversationOrigin: 'service',
        subtype: 'paid_exempt',
      },
    };
    const doc = await MessageModel.create(message(full));
    const read = await MessageModel.findById(doc._id).lean();
    for (const [key, value] of Object.entries(full)) {
      expect(read?.[key as keyof typeof read]).toEqual(value);
    }
  });

  it('validates enums, lengths and coordinates', async () => {
    await expect(MessageModel.create(message({ type: 'gif' }))).rejects.toThrow();
    await expect(MessageModel.create(message({ origin: 'bot' }))).rejects.toThrow();
    await expect(MessageModel.create(message({ status: 'seen' }))).rejects.toThrow();
    await expect(MessageModel.create(message({ text: 'x'.repeat(4097) }))).rejects.toThrow();
    await expect(MessageModel.create(message({ at: undefined }))).rejects.toThrow();
    await expect(
      MessageModel.create(message({ location: { latitude: 91, longitude: 0 } })),
    ).rejects.toThrow();
    await expect(
      MessageModel.create(
        message({ interactive: { kind: 'button', buttons: [{ id: 'b', title: 'x'.repeat(21) }] } }),
      ),
    ).rejects.toThrow();
    await expect(
      MessageModel.create(message({ reactions: [{ emoji: '👍', by: 'bot', at: new Date() }] })),
    ).rejects.toThrow();
  });

  it('one row per wamid per number; one row per client id', async () => {
    const base = ids();
    await MessageModel.create(message({ ...base, waMessageId: 'wamid.SAME' }));
    await expect(
      MessageModel.create(message({ ...base, waMessageId: 'wamid.SAME' })),
    ).rejects.toMatchObject({ code: 11000 });
    await MessageModel.create(
      message({ ...base, channelId: new Types.ObjectId(), waMessageId: 'wamid.SAME' }),
    );
    // many rows without a wamid / client id
    await MessageModel.create(message({ ...base }));
    await MessageModel.create(message({ ...base }));
    await MessageModel.create(message({ ...base, clientId: 'c-1', direction: 'out' }));
    await expect(
      MessageModel.create(message({ ...base, clientId: 'c-1', direction: 'out' })),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('declares paging, retention and search indexes (no stemming)', async () => {
    const indexes = await MessageModel.collection.indexes();
    const keys = indexes.map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        { accountId: 1, conversationId: 1, at: -1, _id: -1 },
        { at: 1 },
        { 'media.status': 1, createdAt: 1 },
      ]),
    );
    const text = indexes.find((i) => i.key._fts === 'text');
    expect(text).toMatchObject({ default_language: 'none' });
    expect(text?.key).toMatchObject({ accountId: 1 });
  });
});

describe('InboxUpload model', () => {
  it('requires the stored-file fields and an expiry; validates the kind', async () => {
    const base: Record<string, unknown> = {
      accountId: new Types.ObjectId(),
      userId: new Types.ObjectId(),
      kind: 'voice',
      storageKey: 'accounts/a/inbox-uploads/u.ogg',
      mimeType: 'audio/ogg',
      size: 10,
      sha256: 'abc',
      expiresAt: new Date(),
    };
    const doc = await InboxUploadModel.create(base);
    expect(doc.toObject()).toMatchObject({ fileName: null, durationSec: null, voice: false });
    await expect(InboxUploadModel.create({ ...base, kind: 'gif' } as never)).rejects.toThrow();
    await expect(InboxUploadModel.create({ ...base, expiresAt: undefined })).rejects.toThrow();
    await expect(InboxUploadModel.create({ ...base, userId: undefined })).rejects.toThrow();
    const indexes = await InboxUploadModel.collection.indexes();
    const expiry = indexes.find((i) => i.key.expiresAt === 1);
    // not TTL: the retention job deletes the stored file first
    expect(expiry?.expireAfterSeconds).toBeUndefined();
  });
});

describe('Contact / account additions', () => {
  it('contact whatsapp profile and whatsapp source', async () => {
    const accountId = new Types.ObjectId();
    const contact = await ContactModel.create({
      accountId,
      phoneE164: '+919000099010',
      source: { type: 'whatsapp' },
      whatsapp: { waId: '919000099010', profileName: 'Test Customer' },
    });
    const read = await ContactModel.findById(contact._id).lean();
    expect(read?.whatsapp).toEqual({
      waId: '919000099010',
      profileName: 'Test Customer',
      lastInboundAt: null,
      blocked: false,
      syncRemovedAt: null,
      nameEditedAt: null,
      keywordAt: null,
      marketing: null,
    });
    const plain = await ContactModel.create({
      accountId,
      phoneE164: '+919000099011',
      source: { type: 'manual' },
    });
    expect(plain.whatsapp).toBeNull();
  });

  it('accounts get the inbox defaults (owner decisions)', async () => {
    const account = await AccountModel.create({ name: 'Inbox Co', slug: 'p10-model-inbox' });
    const read = await AccountModel.findById(account._id).lean();
    expect(read?.settings.inbox).toEqual(DEFAULT_INBOX_SETTINGS);
    await expect(
      AccountModel.create({
        name: 'Bad',
        slug: 'p10-model-bad',
        settings: { inbox: { notifyOnNewMessage: 'always' } },
      } as never),
    ).rejects.toThrow();
  });
});
