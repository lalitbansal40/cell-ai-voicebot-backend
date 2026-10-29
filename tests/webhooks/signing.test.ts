import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  newWebhookSecret,
  SECRET_PREFIX,
  sign,
  signatureHeader,
  verify,
} from '../../src/modules/webhooks/signing';
import { ulid, ULID_FORMAT } from '../../src/shared/ids/ulid';

const { vectors } = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/webhooks/vectors.json'), 'utf8'),
) as { vectors: { secret: string; timestamp: number; body: string; signature: string }[] };

describe('webhook signatures', () => {
  it.each(vectors)('matches the golden vector (ts $timestamp)', (v) => {
    expect(sign(v.secret, v.timestamp, v.body)).toBe(v.signature);
    expect(sign(v.secret, v.timestamp, Buffer.from(v.body))).toBe(v.signature);
    expect(
      verify(`v1=${v.signature}`, [v.secret], v.timestamp, v.body, { now: v.timestamp * 1000 }),
    ).toBe(true);
  });

  it('refuses a tampered body, a wrong secret, an old or future timestamp and bad headers', () => {
    const v = vectors[0] as (typeof vectors)[number];
    const now = v.timestamp * 1000;
    const header = `v1=${v.signature}`;
    expect(verify(header, [v.secret], v.timestamp, `${v.body} `, { now })).toBe(false);
    expect(verify(header, ['whsec_other'], v.timestamp, v.body, { now })).toBe(false);
    expect(verify(header, [v.secret], v.timestamp, v.body, { now: now + 301_000 })).toBe(false);
    expect(verify(header, [v.secret], v.timestamp, v.body, { now: now - 301_000 })).toBe(false);
    expect(verify(header, [v.secret], v.timestamp, v.body, { now: now + 299_000 })).toBe(true);
    expect(verify(undefined, [v.secret], v.timestamp, v.body, { now })).toBe(false);
    expect(verify(header, [v.secret], undefined, v.body, { now })).toBe(false);
    expect(verify(header, [v.secret], 'abc', v.body, { now })).toBe(false);
    expect(verify('v0=deadbeef', [v.secret], v.timestamp, v.body, { now })).toBe(false);
    expect(verify('v1=zz', [v.secret], v.timestamp, v.body, { now })).toBe(false);
    expect(verify(`v1=${v.signature.slice(2)}`, [v.secret], v.timestamp, v.body, { now })).toBe(
      false,
    );
  });

  it('signs with every given secret during a rotation (either verifies)', () => {
    const [a, b] = [newWebhookSecret(), newWebhookSecret()];
    const header = signatureHeader([a, b], 1_761_700_000, 'x');
    expect(header.split(', ')).toHaveLength(2);
    expect(verify(header, [a], 1_761_700_000, 'x', { now: 1_761_700_000_000 })).toBe(true);
    expect(verify(header, [b], 1_761_700_000, 'x', { now: 1_761_700_000_000 })).toBe(true);
    expect(verify(header, ['whsec_c'], 1_761_700_000, 'x', { now: 1_761_700_000_000 })).toBe(false);
  });

  it('makes 32-byte secrets shown as whsec_<base64url>', () => {
    const s = newWebhookSecret();
    expect(s.startsWith(SECRET_PREFIX)).toBe(true);
    expect(Buffer.from(s.slice(SECRET_PREFIX.length), 'base64url')).toHaveLength(32);
    expect(newWebhookSecret()).not.toBe(s);
  });
});

describe('ulid', () => {
  it('is 26 Crockford chars, sortable by time, unique', () => {
    const a = ulid(1_761_700_000_000);
    const b = ulid(1_761_700_000_001);
    expect(a).toMatch(ULID_FORMAT);
    expect(a < b).toBe(true);
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
    expect(new Set(Array.from({ length: 500 }, () => ulid(1)))).toHaveProperty('size', 500);
  });
});
