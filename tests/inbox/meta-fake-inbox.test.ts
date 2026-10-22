import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildFakeCode,
  buildMessagePayload,
  createFakeMetaClient,
  fakeIds,
  fakeMediaSignature,
  inboxMessagesValueSchema,
  isMonoOggOpus,
  verifyFakeMediaSignature,
  type FakeMetaClient,
  type FakeSignup,
} from '../../src/core/meta';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

let redis: Redis;
let fake: FakeMetaClient;
const prefix = uniquePrefix('fake-inbox');
const emitted: Record<string, unknown>[] = [];
const MEDIA = join(__dirname, '../fixtures/meta/media');

beforeAll(async () => {
  redis = (await requireRedis()).client;
  fake = createFakeMetaClient({
    redis,
    prefix,
    appSecret: 'fake-secret',
    statusDelaysMs: [5, 10, 15],
    mediaBaseUrl: 'http://localhost:5199',
  });
  fake.setWebhookEmitter((body) => {
    emitted.push(body);
    return Promise.resolve();
  });
});
afterAll(async () => {
  fake.stopStatusTimers();
  await flushPrefix(redis, prefix);
  redis.disconnect();
});

let n = 0;
const connect = async (over: Partial<FakeSignup> = {}) => {
  n += 1;
  const s: FakeSignup = {
    businessName: `Inbox Business ${String(n)}`,
    phone: `+91 90000 2${String(n).padStart(4, '0')}`,
    displayName: 'Test Business',
    mode: 'cloud_api',
    outcome: 'finish',
    ...over,
  };
  const { accessToken } = await fake.exchangeCode(buildFakeCode(s));
  return { token: accessToken, ids: fakeIds(s.businessName, s.phone), s };
};

const text = (to: string, body = 'Test reply') => buildMessagePayload(to, { type: 'text', body });
const statusesOf = (wamid: string) =>
  emitted
    .flatMap((b) => {
      const value = (b.entry as { changes: { value: unknown }[] }[])[0]?.changes[0]?.value;
      return inboxMessagesValueSchema.parse(value).statuses ?? [];
    })
    .filter((s) => s.id === wamid);

describe('fake Meta — sends and auto statuses', () => {
  it('returns a fake wamid, records the send without text, and emits sent → delivered → read', async () => {
    const { token, ids } = await connect();
    const { waMessageId } = await fake.sendMessage(token, ids.phoneNumberId, {
      ...text('919000001234'),
      context: { message_id: 'wamid.Q' },
    });
    expect(waMessageId).toMatch(/^wamid\.FAKE[0-9A-F]{24}$/);
    await vi.waitFor(() =>
      expect(statusesOf(waMessageId).map((s) => s.status)).toEqual(['sent', 'delivered', 'read']),
    );
    const [first] = statusesOf(waMessageId);
    expect(first).toMatchObject({
      recipient_id: '919000001234',
      pricing: { billable: false, category: 'service' },
    });
    const body = emitted.find((b) => JSON.stringify(b).includes(waMessageId)) as {
      entry: { id: string; changes: { field: string; value: { metadata: unknown } }[] }[];
    };
    expect(body.entry[0]?.id).toBe(ids.wabaId);
    expect(body.entry[0]?.changes[0]).toMatchObject({
      field: 'messages',
      value: { metadata: { phone_number_id: ids.phoneNumberId } },
    });
    const sent = await fake.sentMessages(ids.phoneNumberId);
    expect(sent).toEqual([
      expect.objectContaining({
        waMessageId,
        toLast4: '1234',
        type: 'text',
        replyTo: true,
        voiceValid: null,
      }),
    ]);
    expect(JSON.stringify(sent)).not.toContain('Test reply');
  });

  it('knobs: undeliverable, never read, window closed, throughput twice', async () => {
    const { token, ids } = await connect();
    const failed = await fake.sendMessage(token, ids.phoneNumberId, text('919000000009'));
    await vi.waitFor(() =>
      expect(statusesOf(failed.waMessageId).map((s) => s.status)).toEqual(['sent', 'failed']),
    );
    expect(statusesOf(failed.waMessageId)[1]?.errors?.[0]).toMatchObject({ code: 131026 });

    const unread = await fake.sendMessage(token, ids.phoneNumberId, text('919000000008'));
    await vi.waitFor(() =>
      expect(statusesOf(unread.waMessageId).map((s) => s.status)).toEqual(['sent', 'delivered']),
    );

    await expect(
      fake.sendMessage(token, ids.phoneNumberId, text('919000000007')),
    ).rejects.toMatchObject({
      code: 131047,
    });
    const slow = text('919000000006');
    await expect(fake.sendMessage(token, ids.phoneNumberId, slow)).rejects.toMatchObject({
      code: 130429,
    });
    await expect(fake.sendMessage(token, ids.phoneNumberId, slow)).rejects.toMatchObject({
      code: 130429,
    });
    await expect(fake.sendMessage(token, ids.phoneNumberId, slow)).resolves.toMatchObject({
      waMessageId: expect.any(String) as string,
    });
    // the counter resets after an accepted send
    await expect(fake.sendMessage(token, ids.phoneNumberId, slow)).rejects.toMatchObject({
      code: 130429,
    });
  });

  it('other numbers / tokens are refused; failNext covers the new ops; no emitter = no statuses', async () => {
    const a = await connect();
    const b = await connect();
    await expect(
      fake.sendMessage(a.token, b.ids.phoneNumberId, text('919000001111')),
    ).rejects.toMatchObject({
      code: 100,
    });
    await expect(
      fake.sendMessage('nope', a.ids.phoneNumberId, text('919000001111')),
    ).rejects.toMatchObject({
      code: 190,
    });
    fake.failNext('sendMessage');
    await expect(
      fake.sendMessage(a.token, a.ids.phoneNumberId, text('919000001111')),
    ).rejects.toMatchObject({
      status: 500,
    });
    const quiet = createFakeMetaClient({ redis, prefix, appSecret: 'fake-secret' });
    const { waMessageId } = await quiet.sendMessage(
      a.token,
      a.ids.phoneNumberId,
      text('919000001112'),
    );
    await new Promise((r) => setTimeout(r, 40));
    expect(statusesOf(waMessageId)).toEqual([]);
  });

  it('stopStatusTimers cancels pending statuses', async () => {
    const { token, ids } = await connect();
    const slowFake = createFakeMetaClient({
      redis,
      prefix,
      appSecret: 'fake-secret',
      statusDelaysMs: [60_000, 60_000, 60_000],
    });
    const seen: unknown[] = [];
    slowFake.setWebhookEmitter((body) => {
      seen.push(body);
      return Promise.resolve();
    });
    await slowFake.sendMessage(token, ids.phoneNumberId, text('919000001113'));
    slowFake.stopStatusTimers();
    expect(seen).toEqual([]);
  });

  it('read receipts and typing are recorded', async () => {
    const { token, ids } = await connect();
    await fake.markRead(token, ids.phoneNumberId, 'wamid.IN1');
    await fake.markRead(token, ids.phoneNumberId, 'wamid.IN2', { typing: true });
    expect(await fake.readReceipts(ids.phoneNumberId)).toEqual([
      expect.objectContaining({ waMessageId: 'wamid.IN1', typing: false }),
      expect.objectContaining({ waMessageId: 'wamid.IN2', typing: true }),
    ]);
  });
});

describe('fake Meta — media', () => {
  it('upload → url (signed, our dev route) → download round trip; voice validity on audio sends', async () => {
    const { token, ids } = await connect();
    const ogg = readFileSync(join(MEDIA, 'sample.ogg'));
    const mediaId = await fake.uploadMedia(token, ids.phoneNumberId, {
      bytes: ogg,
      mimeType: 'audio/ogg',
      fileName: 'note.ogg',
    });
    expect(mediaId).toMatch(/^fake_media_[0-9a-f]{20}$/);
    const info = await fake.getMediaUrl(token, mediaId, ids.phoneNumberId);
    expect(info).toMatchObject({ mimeType: 'audio/ogg', size: ogg.length });
    const url = new URL(info.url);
    expect(url.origin).toBe('http://localhost:5199');
    expect(url.pathname).toBe(`/api/v1/dev/meta/media/${mediaId}`);
    const exp = Number(url.searchParams.get('exp'));
    expect(
      verifyFakeMediaSignature('fake-secret', mediaId, exp, url.searchParams.get('sig') ?? ''),
    ).toBe(true);

    const download = await fake.downloadMedia(token, info.url, { maxBytes: 10_000 });
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(ogg);
    expect(download).toMatchObject({ contentType: 'audio/ogg', contentLength: ogg.length });

    const voice = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload('919000001114', { type: 'audio', mediaId }),
    );
    const notVoiceId = await fake.putMedia(readFileSync(join(MEDIA, 'sample.jpg')), 'audio/mpeg');
    const notVoice = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload('919000001114', { type: 'audio', mediaId: notVoiceId }),
    );
    const gone = await fake.sendMessage(
      token,
      ids.phoneNumberId,
      buildMessagePayload('919000001114', { type: 'audio', mediaId: 'fake_media_missing' }),
    );
    const sent = await fake.sentMessages(ids.phoneNumberId);
    const byId = (id: string) => sent.find((s) => s.waMessageId === id);
    expect(byId(voice.waMessageId)).toMatchObject({ type: 'audio', mediaId, voiceValid: true });
    expect(byId(notVoice.waMessageId)?.voiceValid).toBe(false);
    expect(byId(gone.waMessageId)?.voiceValid).toBe(false);
    expect(await fake.readMedia(mediaId)).toMatchObject({ mimeType: 'audio/ogg' });
    await fake.deleteMedia(mediaId);
    expect(await fake.readMedia(mediaId)).toBeNull();
    await expect(fake.getMediaUrl(token, mediaId, ids.phoneNumberId)).rejects.toMatchObject({
      code: 100,
    });
  });

  it('download refuses other hosts, bad / expired signatures, missing media and oversize', async () => {
    const { token, ids } = await connect();
    const id = await fake.putMedia(Buffer.alloc(100), 'image/png', 'x.png');
    const { url } = await fake.getMediaUrl(token, id, ids.phoneNumberId);
    await expect(
      fake.downloadMedia(token, 'https://evil.example/x', { maxBytes: 1000 }),
    ).rejects.toMatchObject({
      type: 'media_host_refused',
    });
    await expect(fake.downloadMedia(token, 'not a url', { maxBytes: 1000 })).rejects.toMatchObject({
      type: 'media_host_refused',
    });
    await expect(
      fake.downloadMedia(token, url.replace(/sig=[0-9a-f]+/, 'sig=00'), { maxBytes: 1000 }),
    ).rejects.toMatchObject({
      status: 403,
    });
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = `http://localhost:5199/api/v1/dev/meta/media/${id}?exp=${String(past)}&sig=${fakeMediaSignature('fake-secret', id, past)}`;
    await expect(fake.downloadMedia(token, expired, { maxBytes: 1000 })).rejects.toMatchObject({
      status: 403,
    });
    await expect(fake.downloadMedia(token, url, { maxBytes: 10 })).rejects.toMatchObject({
      type: 'media_too_large',
    });
    await fake.deleteMedia(id);
    await expect(fake.downloadMedia(token, url, { maxBytes: 1000 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(fake.downloadMedia('nope', url, { maxBytes: 1000 })).rejects.toMatchObject({
      code: 190,
    });
    await expect(
      fake.uploadMedia(token, ids.phoneNumberId, {
        bytes: Buffer.alloc(16 * 1024 * 1024 + 1),
        mimeType: 'video/mp4',
        fileName: 'big.mp4',
      }),
    ).rejects.toMatchObject({ code: 131053 });
  });

  it('isMonoOggOpus / signature helpers', () => {
    const ogg = readFileSync(join(MEDIA, 'sample.ogg'));
    expect(isMonoOggOpus(ogg)).toBe(true);
    const stereo = Buffer.from(ogg);
    stereo[stereo.indexOf('OpusHead', 0, 'latin1') + 9] = 2;
    expect(isMonoOggOpus(stereo)).toBe(false);
    expect(isMonoOggOpus(Buffer.from('OggS'))).toBe(false);
    expect(isMonoOggOpus(readFileSync(join(MEDIA, 'sample.jpg')))).toBe(false);
    const now = 1_000;
    expect(verifyFakeMediaSignature('s', 'm', 2_000, 'zz', now)).toBe(false);
    expect(
      verifyFakeMediaSignature('s', 'm', Number.NaN, fakeMediaSignature('s', 'm', 0), now),
    ).toBe(false);
    expect(
      verifyFakeMediaSignature('s', 'm', 2_000, fakeMediaSignature('s', 'm', 2_000), now),
    ).toBe(true);
    expect(
      verifyFakeMediaSignature('other', 'm', 2_000, fakeMediaSignature('s', 'm', 2_000), now),
    ).toBe(false);
  });
});

describe('fake Meta — block users and business profile', () => {
  it('blocks / unblocks, refuses the 00005 knob, remembers state', async () => {
    const { token, ids } = await connect();
    expect(
      await fake.blockUsers(token, ids.phoneNumberId, ['919000001200', '919000000005']),
    ).toEqual({
      done: ['919000001200'],
      failed: [
        {
          waId: '919000000005',
          code: 139100,
          message: 'Failed to block user: the user has not messaged in the last 24 hours',
        },
      ],
    });
    expect(await fake.isBlocked(ids.phoneNumberId, '+91 90000 01200')).toBe(true);
    expect(await fake.unblockUsers(token, ids.phoneNumberId, ['919000001200'])).toEqual({
      done: ['919000001200'],
      failed: [],
    });
    expect(await fake.isBlocked(ids.phoneNumberId, '919000001200')).toBe(false);
  });

  it('profile defaults, update, photo handle → picture url; bad handles / files refused', async () => {
    const { token, ids } = await connect();
    expect(await fake.getBusinessProfile(token, ids.phoneNumberId)).toEqual({
      about: 'Hello from Test Business',
      address: null,
      description: null,
      email: null,
      profilePictureUrl: null,
      websites: [],
      vertical: 'OTHER',
    });
    const handle = await fake.uploadProfilePhoto(
      token,
      readFileSync(join(MEDIA, 'sample.png')),
      'image/png',
    );
    expect(handle).toMatch(/^fake_handle_/);
    await fake.updateBusinessProfile(token, ids.phoneNumberId, {
      about: 'New about',
      websites: ['https://example.com'],
      vertical: 'FINANCE',
      profilePictureHandle: handle,
    });
    expect(await fake.getBusinessProfile(token, ids.phoneNumberId)).toMatchObject({
      about: 'New about',
      websites: ['https://example.com'],
      vertical: 'FINANCE',
      profilePictureUrl: `https://fake.fbcdn.net/profile/${handle}.jpg`,
    });
    await expect(
      fake.updateBusinessProfile(token, ids.phoneNumberId, { profilePictureHandle: 'real' }),
    ).rejects.toMatchObject({ code: 100 });
    await expect(
      fake.uploadProfilePhoto(token, Buffer.from('x'), 'image/gif'),
    ).rejects.toMatchObject({ code: 100 });
    await expect(
      fake.uploadProfilePhoto(token, Buffer.alloc(0), 'image/png'),
    ).rejects.toMatchObject({ code: 100 });
  });
});
