import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../shared/errors/app-error';

import {
  buildMessagePayload,
  contactToMetaCard,
  metaTypeOf,
  type OutboundContent,
} from './payloads';

const TO = '919000000101';
const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: TO };

const fails = (content: OutboundContent, to = TO): string[] => {
  try {
    buildMessagePayload(to, content);
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as ValidationError).details?.map((d) => d.path) ?? [];
  }
  throw new Error('expected a validation error');
};

describe('buildMessagePayload — exact Graph bodies', () => {
  it('text: preview_url follows a link in the body unless set', () => {
    expect(buildMessagePayload(TO, { type: 'text', body: 'Hello' })).toEqual({
      ...base,
      type: 'text',
      text: { body: 'Hello', preview_url: false },
    });
    expect(
      buildMessagePayload(TO, { type: 'text', body: 'See https://example.com' }),
    ).toMatchObject({
      text: { preview_url: true },
    });
    expect(
      buildMessagePayload(TO, { type: 'text', body: 'See https://example.com', previewUrl: false }),
    ).toMatchObject({ text: { preview_url: false } });
  });

  it('reply context on every type except reactions', () => {
    expect(buildMessagePayload(TO, { type: 'text', body: 'Hi' }, 'wamid.Q')).toMatchObject({
      context: { message_id: 'wamid.Q' },
    });
    expect(
      buildMessagePayload(TO, { type: 'reaction', messageId: 'wamid.T', emoji: '👍' }, 'wamid.Q'),
    ).toEqual({ ...base, type: 'reaction', reaction: { message_id: 'wamid.T', emoji: '👍' } });
    expect(buildMessagePayload(TO, { type: 'text', body: 'Hi' }, null)).not.toHaveProperty(
      'context',
    );
  });

  it('media types (caption only when present, document filename)', () => {
    expect(buildMessagePayload(TO, { type: 'image', mediaId: 'm1', caption: 'Cap' })).toEqual({
      ...base,
      type: 'image',
      image: { id: 'm1', caption: 'Cap' },
    });
    expect(buildMessagePayload(TO, { type: 'video', mediaId: 'm2', caption: null })).toEqual({
      ...base,
      type: 'video',
      video: { id: 'm2' },
    });
    expect(buildMessagePayload(TO, { type: 'audio', mediaId: 'm3' })).toEqual({
      ...base,
      type: 'audio',
      audio: { id: 'm3' },
    });
    expect(
      buildMessagePayload(TO, { type: 'document', mediaId: 'm4', caption: '', fileName: 'a.pdf' }),
    ).toEqual({ ...base, type: 'document', document: { id: 'm4', filename: 'a.pdf' } });
    expect(buildMessagePayload(TO, { type: 'sticker', mediaId: 'm5' })).toEqual({
      ...base,
      type: 'sticker',
      sticker: { id: 'm5' },
    });
  });

  it('location and contacts', () => {
    expect(
      buildMessagePayload(TO, {
        type: 'location',
        latitude: 26.9,
        longitude: 75.8,
        name: 'Office',
      }),
    ).toEqual({
      ...base,
      type: 'location',
      location: { latitude: 26.9, longitude: 75.8, name: 'Office' },
    });
    const card = contactToMetaCard({
      name: 'Asha',
      phoneE164: '+919000000202',
      waId: '919000000202',
    });
    expect(buildMessagePayload(TO, { type: 'contacts', contacts: [card] })).toEqual({
      ...base,
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: 'Asha' },
          phones: [{ phone: '+919000000202', type: 'CELL', wa_id: '919000000202' }],
        },
      ],
    });
  });

  it('interactive buttons with text / media headers and footer', () => {
    expect(
      buildMessagePayload(TO, {
        type: 'buttons',
        body: 'Pay?',
        header: { type: 'text', text: 'Due' },
        footer: 'Thanks',
        buttons: [
          { id: 'yes', title: 'Yes' },
          { id: 'no', title: 'No' },
        ],
      }),
    ).toEqual({
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Due' },
        body: { text: 'Pay?' },
        footer: { text: 'Thanks' },
        action: {
          buttons: [
            { type: 'reply', reply: { id: 'yes', title: 'Yes' } },
            { type: 'reply', reply: { id: 'no', title: 'No' } },
          ],
        },
      },
    });
    expect(
      buildMessagePayload(TO, {
        type: 'buttons',
        body: 'B',
        header: { type: 'image', mediaId: 'img' },
        buttons: [{ id: 'a', title: 'A' }],
      }).interactive,
    ).toMatchObject({ header: { type: 'image', image: { id: 'img' } } });
    expect(
      buildMessagePayload(TO, {
        type: 'buttons',
        body: 'B',
        header: { type: 'document', mediaId: 'doc', fileName: 'x.pdf' },
        buttons: [{ id: 'a', title: 'A' }],
      }).interactive,
    ).toMatchObject({ header: { type: 'document', document: { id: 'doc', filename: 'x.pdf' } } });
  });

  it('interactive list and CTA URL', () => {
    expect(
      buildMessagePayload(TO, {
        type: 'list',
        body: 'Pick',
        header: 'Plans',
        button: 'Options',
        sections: [
          { title: 'EMI', rows: [{ id: 'e3', title: '3 EMIs', description: 'Split' }] },
          { rows: [{ id: 'full', title: 'Pay full' }] },
        ],
      }),
    ).toEqual({
      ...base,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Plans' },
        body: { text: 'Pick' },
        action: {
          button: 'Options',
          sections: [
            { title: 'EMI', rows: [{ id: 'e3', title: '3 EMIs', description: 'Split' }] },
            { rows: [{ id: 'full', title: 'Pay full' }] },
          ],
        },
      },
    });
    expect(
      buildMessagePayload(TO, {
        type: 'cta_url',
        body: 'Pay online',
        footer: 'Secure',
        displayText: 'Pay',
        url: 'https://pay.example.com/x',
      }),
    ).toEqual({
      ...base,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: 'Pay online' },
        footer: { text: 'Secure' },
        action: {
          name: 'cta_url',
          parameters: { display_text: 'Pay', url: 'https://pay.example.com/x' },
        },
      },
    });
    expect(metaTypeOf({ type: 'reaction', messageId: 'x', emoji: '' })).toBe('reaction');
  });
});

describe('buildMessagePayload — limits (defence in depth)', () => {
  it('rejects every limit violation with its path', () => {
    expect(fails({ type: 'text', body: '' })).toEqual(['text']);
    expect(fails({ type: 'text', body: 'x'.repeat(4097) })).toEqual(['text']);
    expect(fails({ type: 'text', body: 'ok' }, '+91 9000')).toEqual(['to']);
    expect(fails({ type: 'image', mediaId: 'm', caption: 'x'.repeat(1025) })).toEqual(['caption']);
    expect(fails({ type: 'document', mediaId: 'm', fileName: '' })).toEqual(['fileName']);
    expect(fails({ type: 'location', latitude: 91, longitude: 0 })).toEqual(['latitude']);
    expect(fails({ type: 'location', latitude: 0, longitude: -181 })).toEqual(['longitude']);
    expect(fails({ type: 'contacts', contacts: [] })).toEqual(['contacts']);
    const btn = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `b${String(i)}`, title: 'T' }));
    expect(fails({ type: 'buttons', body: 'B', buttons: btn(4) })).toEqual(['buttons']);
    expect(fails({ type: 'buttons', body: 'B', buttons: [] })).toEqual(['buttons']);
    expect(
      fails({ type: 'buttons', body: 'B', buttons: [{ id: 'a', title: 'x'.repeat(21) }] }),
    ).toEqual(['buttons.0.title']);
    expect(
      fails({
        type: 'buttons',
        body: 'B',
        buttons: [
          { id: 'a', title: 'A' },
          { id: 'a', title: 'B' },
        ],
      }),
    ).toEqual(['buttons']);
    expect(
      fails({
        type: 'buttons',
        body: 'x'.repeat(1025),
        header: { type: 'text', text: 'x'.repeat(61) },
        footer: 'x'.repeat(61),
        buttons: btn(1),
      }),
    ).toEqual(['body', 'footer', 'header']);
    const rows = (n: number, prefix = 'r') =>
      Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i)}`, title: 'Row' }));
    expect(fails({ type: 'list', body: 'B', button: 'Go', sections: [] })).toEqual([
      'sections',
      'sections',
    ]);
    expect(
      fails({ type: 'list', body: 'B', button: 'Go', sections: [{ rows: rows(11) }] }),
    ).toEqual(['sections']);
    expect(
      fails({
        type: 'list',
        body: 'B',
        button: 'Go',
        sections: [{ rows: rows(1) }, { rows: rows(1) }],
      }),
    ).toEqual(['sections']);
    expect(
      fails({
        type: 'list',
        body: 'B',
        button: 'x'.repeat(21),
        sections: [
          {
            title: 'x'.repeat(25),
            rows: [{ id: 'r', title: 'x'.repeat(25), description: 'x'.repeat(73) }],
          },
        ],
      }),
    ).toEqual([
      'button',
      'sections.0.title',
      'sections.0.rows.0.title',
      'sections.0.rows.0.description',
    ]);
    expect(
      fails({ type: 'cta_url', body: 'B', displayText: 'Pay', url: 'http://example.com' }),
    ).toEqual(['url']);
    expect(
      fails({
        type: 'cta_url',
        body: 'B',
        displayText: 'x'.repeat(21),
        url: 'javascript:alert(1)',
      }),
    ).toEqual(['displayText', 'url']);
    expect(fails({ type: 'reaction', messageId: 'w', emoji: '👍👍👍👍👍👍👍👍👍' })).toEqual([
      'emoji',
    ]);
  });
});

describe('contactToMetaCard', () => {
  it('falls back to the number for the name; email when present', () => {
    expect(
      contactToMetaCard({ name: '  ', phoneE164: '+919000000303', email: 'a@example.com' }),
    ).toEqual({
      name: { formatted_name: '+919000000303' },
      phones: [{ phone: '+919000000303', type: 'CELL' }],
      emails: [{ email: 'a@example.com', type: 'WORK' }],
    });
    expect(contactToMetaCard({ name: null, phoneE164: '+919000000304' }).name.formatted_name).toBe(
      '+919000000304',
    );
  });
});
