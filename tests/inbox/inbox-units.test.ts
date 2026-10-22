import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_INBOX_SETTINGS } from '../../src/db/models/account.model';
import { MESSAGE_STATUSES } from '../../src/db/models/message.model';
import { matchKeyword, normalizeKeyword } from '../../src/modules/inbox/keywords';
import { blankContent } from '../../src/modules/inbox/message-store';
import { last4, normalizeInbound } from '../../src/modules/inbox/normalize';
import { buildPreview, TYPE_LABELS } from '../../src/modules/inbox/preview';
import { mimeAgrees, sniff } from '../../src/modules/inbox/sniff';
import { canMoveTo, fromMetaStatus } from '../../src/modules/inbox/status-rank';

const DIR = join(__dirname, '../fixtures/meta');
const first = (name: string) => {
  const p = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as {
    entry: { changes: { value: { messages: unknown[] } }[] }[];
  };
  return p.entry[0]?.changes[0]?.value.messages[0];
};
const norm = (name: string) => {
  const n = normalizeInbound(first(name));
  if (!n) throw new Error(`no message in ${name}`);
  return n;
};

describe('normalizeInbound — every inbound type', () => {
  it('text, link, reply, forwarded, referral', () => {
    const t = norm('messages-text-link.json');
    expect(t).toMatchObject({ from: '919000000101', to: null, mediaId: null });
    expect(t.content).toMatchObject({
      type: 'text',
      text: 'Test link https://example.com/offer',
      context: null,
    });
    expect(t.metaTimestamp?.toISOString()).toBe('2025-10-22T08:00:00.000Z');
    expect(norm('messages-reply.json').content.context).toMatchObject({
      replyToWaMessageId: 'wamid.HBgMOTE5MDAwMDAwMTAxFQIAERgSOUTGOINGTEST',
      replyToMessageId: null,
      forwarded: false,
    });
    expect(norm('messages-forwarded.json').content.context).toMatchObject({
      forwarded: true,
      frequentlyForwarded: true,
    });
    expect(norm('messages-referral.json').content.context?.referral).toEqual({
      sourceUrl: 'https://fb.me/test-ad',
      sourceType: 'ad',
      sourceId: '120000000000001',
      headline: 'Test ad headline',
      body: 'Test ad body',
      ctwaClid: 'test-clid',
    });
  });

  it('media types keep the Meta media id, caption, file name, voice / animated flags', () => {
    const img = norm('messages-image.json');
    expect(img.mediaId).toBe('1000000000000001');
    expect(img.content).toMatchObject({
      type: 'image',
      text: 'Test photo caption',
      media: {
        metaMediaId: '1000000000000001',
        mimeType: 'image/jpeg',
        status: 'pending',
        voice: false,
      },
    });
    expect(norm('messages-voice.json').content.media).toMatchObject({
      voice: true,
      mimeType: 'audio/ogg; codecs=opus',
    });
    expect(norm('messages-audio.json').content.media?.voice).toBe(false);
    expect(norm('messages-document.json').content.media?.fileName).toBe('test-statement.pdf');
    expect(norm('messages-sticker-animated.json').content.media?.animated).toBe(true);
    expect(norm('messages-video.json').content.type).toBe('video');
    // a path in a file name never survives
    const evil = normalizeInbound({
      from: '919000000101',
      id: 'w1',
      timestamp: '1761120000',
      type: 'document',
      document: { id: 'm', filename: '../../etc/passwd' },
    });
    expect(evil?.content.media).toMatchObject({
      fileName: '.._.._etc_passwd',
      mimeType: 'application/octet-stream',
    });
  });

  it('location, contacts, interactive replies, form, template button, reaction, order, system, unsupported', () => {
    expect(norm('messages-location.json').content.location).toEqual({
      latitude: 26.9124,
      longitude: 75.7873,
      name: 'Test Office',
      address: 'Test Road, Jaipur',
      url: 'https://example.com/map',
    });
    expect(norm('messages-contacts.json').content.contacts).toEqual([
      {
        name: 'Test Friend',
        phones: [{ phone: '+91 90000 00202', type: 'CELL', waId: '919000000202' }],
        emails: [{ email: 'friend@example.com', type: 'WORK' }],
        org: 'Test Org',
      },
    ]);
    expect(norm('messages-button-reply.json').content.interactive).toMatchObject({
      kind: 'button_reply',
      reply: { id: 'pay_now', title: 'Pay now', description: null },
    });
    expect(norm('messages-list-reply.json').content.interactive?.reply).toEqual({
      id: 'emi_3',
      title: '3 EMIs',
      description: 'Split in three',
    });
    expect(norm('messages-nfm-reply.json').content.interactive).toMatchObject({
      kind: 'nfm_reply',
      nfmResponse: '{"flow_token":"test","choice":"A"}',
      nfmTruncated: false,
    });
    expect(norm('messages-template-button.json').content).toMatchObject({
      type: 'button',
      text: 'Remind me later',
      button: { payload: 'TEST_PAYLOAD', text: 'Remind me later' },
    });
    expect(norm('messages-reaction.json').content.reaction).toEqual({
      targetWaMessageId: 'wamid.HBgMOTE5MDAwMDAwMTAxFQIAERgSOUTGOINGTEST',
      targetMessageId: null,
      emoji: '👍',
    });
    expect(norm('messages-reaction-removed.json').content.reaction?.emoji).toBe('');
    expect(norm('messages-order.json').content.order).toEqual({
      catalogId: 'test-catalog',
      itemsCount: 3,
      total: 600,
      currency: 'INR',
    });
    expect(norm('messages-system-number-changed.json').content.system).toEqual({
      kind: 'user_changed_number',
      newWaIdLast4: '0909',
    });
    expect(norm('messages-unsupported.json').content).toMatchObject({
      type: 'unsupported',
      error: {
        code: 131051,
        title: 'Message type unknown',
        reason: "This message type isn't supported yet",
      },
    });
  });

  it('oversized forms are truncated; odd / unknown shapes become unsupported; unreadable → null', () => {
    const big = normalizeInbound({
      from: '919000000101',
      id: 'w2',
      timestamp: 1761120000,
      type: 'interactive',
      interactive: { type: 'nfm_reply', nfm_reply: { response_json: 'x'.repeat(9000) } },
    });
    expect(big?.content.interactive).toMatchObject({ nfmTruncated: true });
    expect(big?.content.interactive?.nfmResponse).toHaveLength(8192);
    const weird = normalizeInbound({
      from: '91 9000',
      id: 'w3',
      timestamp: 'x',
      type: 'location',
      location: { latitude: 'n' },
    });
    expect(weird).toMatchObject({
      waMessageId: 'w3',
      from: '919000',
      metaTimestamp: null,
      content: { type: 'unsupported' },
    });
    const newType = normalizeInbound({
      from: '919000000101',
      id: 'w4',
      timestamp: '1',
      type: 'hologram',
    });
    expect(newType?.content).toMatchObject({ type: 'unsupported', error: { code: null } });
    expect(normalizeInbound({ type: 'text' })).toBeNull();
    expect(normalizeInbound('nope')).toBeNull();
    // missing parts of a known type → unsupported
    for (const type of [
      'text',
      'location',
      'contacts',
      'interactive',
      'button',
      'reaction',
      'order',
      'system',
    ]) {
      expect(
        normalizeInbound({ from: '1', id: `x-${type}`, timestamp: '1', type })?.content.type,
      ).toBe('unsupported');
    }
    expect(
      normalizeInbound({
        from: '1',
        id: 'x-i',
        timestamp: '1',
        type: 'interactive',
        interactive: { type: 'button_reply' },
      })?.content.type,
    ).toBe('unsupported');
    // contacts without a formatted name fall back to first / last, then "Contact"
    const cards = normalizeInbound({
      from: '1',
      id: 'x-c',
      timestamp: '1',
      type: 'contacts',
      contacts: [{ name: { first_name: 'A', last_name: 'B' }, phones: [{ wa_id: '919' }, {}] }, {}],
    });
    expect(cards?.content.contacts?.map((c) => c.name)).toEqual(['A B', 'Contact']);
    expect(cards?.content.contacts?.[0]?.phones).toEqual([
      { phone: '919', type: null, waId: '919' },
    ]);
    expect(last4(null)).toBeNull();
    // order without prices
    const order = normalizeInbound({
      from: '1',
      id: 'x-o',
      timestamp: '1',
      type: 'order',
      order: { product_items: [] },
    });
    expect(order?.content.order).toEqual({
      catalogId: null,
      itemsCount: 0,
      total: null,
      currency: null,
    });
    const priceless = normalizeInbound({
      from: '1',
      id: 'x-p',
      timestamp: '1',
      type: 'order',
      order: { product_items: [{ quantity: 'x' }] },
    });
    expect(priceless?.content.order).toMatchObject({ itemsCount: 1, total: 0 });
    // echoes carry the customer in `to`
    expect(
      normalizeInbound({
        from: '919000000010',
        to: '+91 90000 00101',
        id: 'e',
        timestamp: '1',
        type: 'text',
        text: { body: 'x' },
      })?.to,
    ).toBe('919000000101');
    expect(
      normalizeInbound({
        from: '1',
        to: 5,
        id: 'e2',
        timestamp: 'zz',
        type: 'location',
        location: { latitude: 'a' },
      })?.to,
    ).toBeNull();
  });
});

describe('buildPreview', () => {
  const p = (over: Partial<Parameters<typeof buildPreview>[0]>) =>
    buildPreview({ ...blankContent('text'), ...over });
  it('text / caption / type labels, one line, ≤ 120', () => {
    expect(p({ text: ' Hello\n\nthere ' })).toBe('Hello there');
    expect(p({ text: 'x'.repeat(200) })).toHaveLength(120);
    expect(p({ type: 'image', text: null })).toBe('Photo');
    expect(p({ type: 'image', text: 'Cap' })).toBe('Cap');
    expect(p({ type: 'audio', media: { voice: true } as never })).toBe('Voice note');
    expect(p({ type: 'audio', media: null })).toBe('Audio');
    expect(p({ type: 'document', media: { fileName: 'a.pdf' } as never })).toBe('a.pdf');
    expect(p({ type: 'document' })).toBe('Document');
    expect(p({ type: 'contacts', contacts: [{ name: 'Asha' } as never] })).toBe('Contact: Asha');
    expect(p({ type: 'contacts', contacts: null })).toBe('Contact');
    expect(p({ type: 'location', location: { name: 'Office' } as never })).toBe('Location: Office');
    expect(p({ type: 'location' })).toBe('Location');
    expect(
      p({
        type: 'interactive',
        interactive: { kind: 'button_reply', reply: { title: 'Yes' } } as never,
      }),
    ).toBe('Replied: Yes');
    expect(
      p({ type: 'interactive', interactive: { kind: 'list_reply', reply: null } as never }),
    ).toBe('Replied:');
    expect(p({ type: 'interactive', interactive: { kind: 'nfm_reply' } as never })).toBe(
      'Form submitted',
    );
    expect(
      p({ type: 'interactive', interactive: { kind: 'button', body: 'Pick one' } as never }),
    ).toBe('Pick one');
    expect(p({ type: 'interactive', interactive: { kind: 'list', body: null } as never })).toBe(
      'Interactive message',
    );
    expect(p({ type: 'interactive', interactive: null })).toBe('Interactive message');
    expect(p({ type: 'reaction', reaction: { emoji: '👍' } as never })).toBe('Reacted 👍');
    expect(p({ type: 'reaction', reaction: { emoji: '' } as never })).toBe('Removed a reaction');
    expect(p({ type: 'system' })).toBe('System message');
    expect(p({ type: 'unsupported', text: 'ignored' })).toBe('Unsupported message');
    expect(p({ type: 'note', text: null })).toBe(TYPE_LABELS.note);
  });
});

describe('keywords (owner decision: English + Hinglish + Hindi, whole message)', () => {
  const lists = DEFAULT_INBOX_SETTINGS;
  it('every default keyword matches as typed, in any case / spacing / trailing punctuation or emoji', () => {
    for (const k of lists.optOutKeywords) {
      expect(matchKeyword(k, lists), k).toBe('opt_out');
      expect(matchKeyword(`  ${k.toLowerCase()} !!`, lists), k).toBe('opt_out');
    }
    for (const k of lists.optInKeywords) expect(matchKeyword(`${k}.`, lists), k).toBe('opt_in');
    expect(matchKeyword('band   karo 🙏', lists)).toBe('opt_out');
    expect(matchKeyword('👍 stop', lists)).toBe('opt_out');
    expect(matchKeyword('बंद करो।', lists)).toBe('opt_out');
    expect(matchKeyword('Shuru karo!', lists)).toBe('opt_in');
  });

  it('NFD Devanagari equals NFC', () => {
    const nfd = 'बंद करो'.normalize('NFD');
    expect(matchKeyword(nfd, lists)).toBe('opt_out');
    expect(normalizeKeyword('ñ'.normalize('NFD'))).toBe('Ñ');
  });

  it('sentences that contain a keyword never match', () => {
    for (const text of [
      'mera order band karo mat',
      'stop by tomorrow?',
      'please stop sending reminders on sunday',
      'START date kab hai',
      'cancel my booking for friday',
      'shuru se batao',
      'बंद करो मत',
      '',
      '   ',
      '🙏',
      'x'.repeat(100),
    ]) {
      expect(matchKeyword(text, lists), text).toBeNull();
    }
    expect(matchKeyword(null, lists)).toBeNull();
    expect(matchKeyword('roko', { optOutKeywords: ['ROKO'], optInKeywords: [] })).toBe('opt_out');
  });
});

describe('status ranking (every pair)', () => {
  it('maps Meta statuses', () => {
    expect(
      ['sent', 'delivered', 'read', 'played', 'failed', 'deleted', 'READ', 'warning'].map(
        fromMetaStatus,
      ),
    ).toEqual(['sent', 'delivered', 'read', 'read', 'failed', 'deleted', 'read', null]);
  });

  it('outgoing: forward only; failed only below delivered; a failed message can still get delivered / read', () => {
    const allowed: string[] = [];
    for (const from of MESSAGE_STATUSES) {
      for (const to of MESSAGE_STATUSES)
        if (canMoveTo(from, to, 'out')) allowed.push(`${from}>${to}`);
    }
    expect(allowed.sort()).toEqual(
      [
        'queued>accepted',
        'queued>sent',
        'queued>delivered',
        'queued>read',
        'queued>failed',
        'accepted>sent',
        'accepted>delivered',
        'accepted>read',
        'accepted>failed',
        'sent>delivered',
        'sent>read',
        'sent>failed',
        'delivered>read',
        'failed>delivered',
        'failed>read',
      ].sort(),
    );
  });

  it('inbound: only received → deleted', () => {
    const allowed: string[] = [];
    for (const from of MESSAGE_STATUSES) {
      for (const to of MESSAGE_STATUSES)
        if (canMoveTo(from, to, 'in')) allowed.push(`${from}>${to}`);
    }
    expect(allowed).toEqual(['received>deleted']);
  });
});

describe('sniff — magic bytes', () => {
  const media = (name: string) => readFileSync(join(DIR, 'media', name));
  it('recognises every type WhatsApp takes', () => {
    expect(sniff(media('sample.jpg'))).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
      kinds: ['image'],
    });
    expect(sniff(media('sample.png'))).toMatchObject({ mime: 'image/png', kinds: ['image'] });
    expect(sniff(media('sample.webp'))).toMatchObject({ mime: 'image/webp', kinds: ['sticker'] });
    expect(sniff(media('sample.mp4'))).toMatchObject({ mime: 'video/mp4', kinds: ['video'] });
    expect(sniff(media('sample.ogg'))).toMatchObject({ mime: 'audio/ogg', kinds: ['audio'] });
    expect(sniff(media('sample.pdf'))).toMatchObject({
      mime: 'application/pdf',
      kinds: ['document'],
    });
    const ftyp = (brand: string) =>
      Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);
    expect(sniff(ftyp('M4A '))).toMatchObject({ mime: 'audio/mp4', kinds: ['audio'] });
    expect(sniff(ftyp('3gp5'))).toMatchObject({ mime: 'video/3gpp' });
    expect(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]))).toMatchObject({
      mime: 'audio/webm',
      kinds: [],
    });
    expect(sniff(Buffer.from('ID3\x04\x00test', 'latin1'))).toMatchObject({ mime: 'audio/mpeg' });
    expect(sniff(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toMatchObject({ mime: 'audio/mpeg' });
    expect(sniff(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toMatchObject({ mime: 'audio/aac' });
    expect(sniff(Buffer.from('#!AMR\nxx'))).toMatchObject({ mime: 'audio/amr' });
    expect(sniff(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toMatchObject({
      mime: 'application/msword',
    });
    const zip = (entry: string) =>
      Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`....${entry}....`)]);
    expect(sniff(zip('[Content_Types].xml word/document.xml'))?.ext).toBe('docx');
    expect(sniff(zip('xl/workbook.xml'))?.ext).toBe('xlsx');
    expect(sniff(zip('ppt/presentation.xml'))?.ext).toBe('pptx');
    expect(sniff(zip('[Content_Types].xml other/'))).toBeNull();
    expect(sniff(zip('random.bin'))).toBeNull();
    expect(sniff(Buffer.from('Plain text notes\nline 2'))).toMatchObject({
      mime: 'text/plain',
      kinds: ['document'],
    });
    expect(sniff(Buffer.from('ok'))).toMatchObject({ mime: 'text/plain' });
  });

  it('refuses everything else (SVG / HTML are text but binary junk is not; GIF; empty)', () => {
    expect(sniff(Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0]))).toBeNull();
    expect(sniff(Buffer.from([0, 1, 2, 3, 4, 5]))).toBeNull();
    expect(sniff(Buffer.alloc(0))).toBeNull();
    expect(sniff(Buffer.from([0xc3]))).toBeNull();
    // a long valid UTF-8 text cut in the middle of a character is still text
    expect(sniff(Buffer.from('अ'.repeat(5000)))).toMatchObject({ mime: 'text/plain' });
    expect(
      sniff(Buffer.concat([Buffer.from('x'.repeat(100)), Buffer.from([0xff, 0xfe, 0xfd])])),
    ).toBeNull();
  });

  it('mimeAgrees: same family for media, loose for documents, webp exact', () => {
    const jpg = sniff(media('sample.jpg'))!;
    expect(mimeAgrees('image/jpeg', jpg)).toBe(true);
    expect(mimeAgrees('image/png', jpg)).toBe(true);
    expect(mimeAgrees('video/mp4', jpg)).toBe(false);
    expect(mimeAgrees(null, jpg)).toBe(true);
    expect(mimeAgrees('application/octet-stream', jpg)).toBe(true);
    expect(mimeAgrees('audio/ogg; codecs=opus', sniff(media('sample.ogg'))!)).toBe(true);
    const pdf = sniff(media('sample.pdf'))!;
    expect(mimeAgrees('application/x-pdf', pdf)).toBe(true);
    expect(mimeAgrees('image/jpeg', pdf)).toBe(false);
    const webp = sniff(media('sample.webp'))!;
    expect(mimeAgrees('image/webp', webp)).toBe(true);
    expect(mimeAgrees('image/png', webp)).toBe(false);
  });
});
