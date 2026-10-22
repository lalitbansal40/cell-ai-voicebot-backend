import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildSignedRequest,
  parseSignedRequest,
  safeEqualString,
  SignedRequestInvalid,
  signWebhook,
  verifyWebhookSignature,
} from './signature';

const SECRET = 'test-app-secret-0123456789abcdef';
const body = Buffer.from('{"object":"whatsapp_business_account","entry":[]}');

describe('verifyWebhookSignature', () => {
  const good = signWebhook(body, SECRET);
  const tampered = Buffer.from(body);
  tampered[3] = 0x41;

  it.each([
    ['valid', body, good, SECRET, true],
    ['valid, upper-case hex', body, `sha256=${good.slice(7).toUpperCase()}`, SECRET, true],
    ['tampered byte', tampered, good, SECRET, false],
    ['missing header', body, undefined, SECRET, false],
    ['wrong prefix', body, good.replace('sha256=', 'sha1='), SECRET, false],
    ['no prefix', body, good.slice(7), SECRET, false],
    ['other secret', body, signWebhook(body, 'another-secret'), SECRET, false],
    ['short hex', body, good.slice(0, 40), SECRET, false],
    ['not hex', body, `sha256=${'z'.repeat(64)}`, SECRET, false],
    ['empty secret', body, signWebhook(body, ''), '', false],
  ])('%s', (_name, raw, header, secret, expected) => {
    expect(verifyWebhookSignature(raw, header, secret)).toBe(expected);
  });

  it('signs like Meta (hex HMAC-SHA256 of the raw bytes)', () => {
    expect(good).toBe(`sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`);
    expect(signWebhook(body.toString(), SECRET)).toBe(good);
  });
});

describe('safeEqualString', () => {
  it('compares in constant time, length mismatch false', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
    expect(safeEqualString('abc', 'abd')).toBe(false);
    expect(safeEqualString('abc', 'abcd')).toBe(false);
  });
});

describe('parseSignedRequest', () => {
  const now = 1_761_120_000;
  const max = 86_400;
  const sign = (payload: Record<string, unknown>) => buildSignedRequest(payload, SECRET);
  const reason = (value: string) => {
    try {
      parseSignedRequest(value, SECRET, now, max);
      return 'ok';
    } catch (err) {
      expect(err).toBeInstanceOf(SignedRequestInvalid);
      return (err as SignedRequestInvalid).reason;
    }
  };

  it('returns the user id and issued_at', () => {
    expect(
      parseSignedRequest(
        sign({ algorithm: 'HMAC-SHA256', user_id: '2000000000000001', issued_at: now - 10 }),
        SECRET,
        now,
        max,
      ),
    ).toEqual({ userId: '2000000000000001', issuedAt: now - 10 });
    // numeric user ids and a lower-case algorithm are accepted
    const numeric = sign({ algorithm: 'hmac-sha256', user_id: 42, issued_at: now });
    expect(parseSignedRequest(numeric, SECRET, now, max).userId).toBe('42');
  });

  it.each([
    ['no dot', 'abc', 'bad_format'],
    ['three parts', 'a.b.c', 'bad_format'],
    ['empty part', '.abc', 'bad_format'],
    ['not base64url', 'a+b.c/d', 'bad_format'],
  ])('%s → %s', (_n, value, expected) => {
    expect(reason(value)).toBe(expected);
  });

  it('rejects bad signatures, algorithms, payloads and old requests', () => {
    const good = sign({ algorithm: 'HMAC-SHA256', user_id: '1', issued_at: now });
    const payloadPart = good.split('.')[1] ?? '';
    expect(reason(`${'A'.repeat(43)}.${payloadPart}`)).toBe('bad_signature');
    expect(
      reason(buildSignedRequest({ algorithm: 'HMAC-SHA256', user_id: '1', issued_at: now }, 'x')),
    ).toBe('bad_signature');
    expect(reason(sign({ algorithm: 'MD5', user_id: '1', issued_at: now }))).toBe('bad_algorithm');
    expect(reason(sign({ user_id: '1', issued_at: now }))).toBe('bad_algorithm');
    expect(reason(sign({ algorithm: 'HMAC-SHA256', issued_at: now }))).toBe('bad_format');
    expect(reason(sign({ algorithm: 'HMAC-SHA256', user_id: '', issued_at: now }))).toBe(
      'bad_format',
    );
    expect(reason(sign({ algorithm: 'HMAC-SHA256', user_id: '1' }))).toBe('bad_format');
    expect(reason(sign({ algorithm: 'HMAC-SHA256', user_id: '1', issued_at: now - max - 1 }))).toBe(
      'expired',
    );
    expect(reason(sign({ algorithm: 'HMAC-SHA256', user_id: '1', issued_at: now + 301 }))).toBe(
      'expired',
    );
    // payload signed correctly but not JSON / not an object
    const raw = (text: string) => {
      const p = Buffer.from(text).toString('base64url');
      return `${createHmac('sha256', SECRET).update(p).digest('base64url')}.${p}`;
    };
    expect(reason(raw('not json'))).toBe('bad_format');
    expect(reason(raw('null'))).toBe('bad_format');
    expect(() => parseSignedRequest(good, '', now, max)).toThrow(SignedRequestInvalid);
  });
});
