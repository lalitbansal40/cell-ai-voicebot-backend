import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  blockUsersSchema,
  businessProfileSchema,
  inboundMessageSchema,
  inboxEchoesValueSchema,
  inboxHistoryValueSchema,
  inboxMessagesValueSchema,
  inboxStateSyncValueSchema,
  mediaUploadSchema,
  mediaUrlSchema,
  metaTime,
  sendMessageSchema,
  uploadHandleSchema,
  uploadSessionSchema,
  webhookEnvelopeSchema,
} from '../../src/core/meta';

const DIR = join(__dirname, '../fixtures/meta');
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const valueOf = (name: string): unknown => {
  const env = webhookEnvelopeSchema.parse(load(name));
  return env.entry[0]?.changes[0]?.value;
};

describe('Phase 10 Meta fixtures parse', () => {
  const messageFixtures = readdirSync(DIR).filter((f) => f.startsWith('messages-'));
  const statusFixtures = readdirSync(DIR).filter((f) => f.startsWith('statuses-'));

  it('has a fixture for every inbound type and status', () => {
    expect(messageFixtures).toHaveLength(22);
    expect(statusFixtures.sort()).toEqual([
      'statuses-deleted.json',
      'statuses-delivered.json',
      'statuses-failed.json',
      'statuses-played.json',
      'statuses-read.json',
      'statuses-sent.json',
    ]);
  });

  it.each(messageFixtures)('%s: messages value + each message', (name) => {
    const value = inboxMessagesValueSchema.parse(valueOf(name));
    expect(value.contacts?.[0]).toMatchObject({
      wa_id: '919000000101',
      profile: { name: 'Test Customer' },
    });
    for (const raw of value.messages ?? []) {
      const msg = inboundMessageSchema.parse(raw);
      expect(msg.from).toBe('919000000101');
      expect(metaTime(msg.timestamp)).toBeInstanceOf(Date);
    }
  });

  it.each(statusFixtures)('%s: statuses value', (name) => {
    const value = inboxMessagesValueSchema.parse(valueOf(name));
    expect(value.statuses).toHaveLength(1);
  });

  it('the parsed content of key types', () => {
    const one = (name: string) =>
      inboundMessageSchema.parse(inboxMessagesValueSchema.parse(valueOf(name)).messages?.[0]);
    expect(one('messages-voice.json').audio).toMatchObject({
      voice: true,
      mime_type: 'audio/ogg; codecs=opus',
    });
    expect(one('messages-sticker-animated.json').sticker?.animated).toBe(true);
    expect(one('messages-document.json').document?.filename).toBe('test-statement.pdf');
    expect(one('messages-location.json').location).toMatchObject({ latitude: 26.9124 });
    expect(one('messages-contacts.json').contacts?.[0]?.phones?.[0]?.wa_id).toBe('919000000202');
    expect(one('messages-button-reply.json').interactive?.button_reply?.id).toBe('pay_now');
    expect(one('messages-list-reply.json').interactive?.list_reply?.description).toBe(
      'Split in three',
    );
    expect(one('messages-nfm-reply.json').interactive?.nfm_reply?.response_json).toContain(
      'flow_token',
    );
    expect(one('messages-template-button.json').button?.payload).toBe('TEST_PAYLOAD');
    expect(one('messages-reaction.json').reaction?.emoji).toBe('👍');
    expect(one('messages-reaction-removed.json').reaction?.emoji ?? null).toBeNull();
    expect(one('messages-forwarded.json').context?.frequently_forwarded).toBe(true);
    expect(one('messages-referral.json').referral?.ctwa_clid).toBe('test-clid');
    expect(one('messages-order.json').order?.product_items).toHaveLength(2);
    expect(one('messages-system-number-changed.json').system?.new_wa_id).toBe('919000000909');
    expect(one('messages-unsupported.json').errors?.[0]?.code).toBe(131051);
    const failed = inboxMessagesValueSchema.parse(valueOf('statuses-failed.json')).statuses?.[0];
    expect(failed?.errors?.[0]?.code).toBe(131026);
  });

  it('coexistence values (echoes, history, state sync)', () => {
    expect(
      inboxEchoesValueSchema.parse(valueOf('webhook-smb-message-echoes.json')).message_echoes,
    ).toHaveLength(1);
    const history = inboxHistoryValueSchema.parse(valueOf('webhook-history-chunk.json'));
    expect(history.history[0]?.threads?.[0]?.messages).toHaveLength(1);
    const echo = inboundMessageSchema.parse(
      inboxEchoesValueSchema.parse(valueOf('webhook-smb-message-echoes.json')).message_echoes[0],
    );
    expect(echo.to).toBe('919000000101');
    expect(
      inboxStateSyncValueSchema.parse(valueOf('webhook-smb-app-state-sync.json')).state_sync.length,
    ).toBeGreaterThan(0);
  });

  it('a message with an unexpected shape fails on its own (stored as unsupported later)', () => {
    expect(inboundMessageSchema.safeParse({ id: 'x', type: 'text' }).success).toBe(false);
    expect(
      inboundMessageSchema.safeParse({
        id: 'x',
        from: '1',
        timestamp: '1',
        type: 'location',
        location: { latitude: 'north' },
      }).success,
    ).toBe(false);
    // the envelope still parses: messages are unknown until parsed one by one
    expect(
      inboxMessagesValueSchema.safeParse({
        metadata: { phone_number_id: '1' },
        messages: [{ broken: true }],
      }).success,
    ).toBe(true);
  });

  it('graph answers', () => {
    expect(sendMessageSchema.parse(load('graph-message-sent.json')).messages[0]?.id).toMatch(
      /^wamid\./,
    );
    expect(mediaUploadSchema.parse(load('graph-media-upload.json')).id).toBe('2000000000000001');
    expect(mediaUrlSchema.parse(load('graph-media-url.json')).file_size).toBe(303833);
    expect(businessProfileSchema.parse(load('graph-business-profile.json')).data).toHaveLength(1);
    expect(
      blockUsersSchema.parse(load('graph-block-users.json')).block_users?.failed_users,
    ).toHaveLength(1);
    expect(
      blockUsersSchema.parse(load('graph-unblock-users.json')).block_users?.removed_users,
    ).toHaveLength(1);
    expect(uploadSessionSchema.parse(load('graph-upload-session.json')).id).toMatch(/^upload:/);
    expect(uploadHandleSchema.parse(load('graph-upload-handle.json')).h).toContain('TESTHANDLE');
    expect(sendMessageSchema.safeParse({ messages: [] }).success).toBe(false);
  });

  it('metaTime: unix seconds as string / number; junk → null', () => {
    expect(metaTime('1761120000')?.toISOString()).toBe('2025-10-22T08:00:00.000Z');
    expect(metaTime(1761120000)?.getTime()).toBe(1761120000_000);
    for (const bad of [null, undefined, '', 'soon', 0, -5]) expect(metaTime(bad)).toBeNull();
  });
});
