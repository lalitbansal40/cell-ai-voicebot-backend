import { SignJWT, UnsecuredJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ACCESS_AUDIENCE, ISSUER } from './auth.constants';
import { hmacToken, randomOtp, randomToken, safeEqualHex, sha256Hex } from './hmac';
import {
  hashPassword,
  validatePasswordPolicy,
  verifyAgainstDummy,
  verifyPassword,
} from './password';
import { getAuthSecrets } from './secrets';
import { signAccessToken, verifyAccessToken, type AccessClaims } from './tokens';

const claims: AccessClaims = { sub: 'u1', acc: 'a1', rid: 'r1', tv: 3, sid: 'fam1' };

describe('password hashing', () => {
  it('hashes with argon2id and verifies', async () => {
    const hash = await hashPassword('Correct-Horse-9');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, 'Correct-Horse-9')).toEqual({ ok: true, needsRehash: false });
    expect(await verifyPassword(hash, 'wrong-password')).toEqual({ ok: false, needsRehash: false });
  });

  it('flags hashes made with other parameters for rehash', async () => {
    const { hash } = await import('@node-rs/argon2');
    const weak = await hash('Correct-Horse-9', { memoryCost: 8192, timeCost: 1, parallelism: 1 });
    expect(await verifyPassword(weak, 'Correct-Horse-9')).toEqual({ ok: true, needsRehash: true });
  });

  it('treats a malformed hash as a failed verify', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toEqual({ ok: false, needsRehash: false });
  });

  it('runs a dummy verify for unknown users', async () => {
    await expect(verifyAgainstDummy('anything')).resolves.toBe(false);
  });
});

describe('validatePasswordPolicy', () => {
  const msgs = (pw: string, ctx = {}) => validatePasswordPolicy(pw, ctx).map((d) => d.message);

  it.each([
    ['short', 'Must be at least 10 characters.'],
    ['x'.repeat(129), 'Must be at most 128 characters.'],
    ['1234567890', 'This password is too common.'],
    ['QWERTYUIOP', 'This password is too common.'],
  ])('rejects %s', (pw, message) => {
    expect(msgs(pw)).toContain(message);
  });

  it('rejects passwords containing the email or equal to the name', () => {
    expect(msgs('asha@example.com', { email: 'Asha@Example.com' })).toContain(
      'Must not contain your email address.',
    );
    expect(msgs('my-ashaverma-pass', { email: 'ashaverma@example.com' })).toContain(
      'Must not contain your email address.',
    );
    expect(msgs('AshaVermaKumar', { name: 'Asha Verma Kumar' })).toContain(
      'Must not be your name.',
    );
  });

  it('accepts a long uncommon passphrase', () => {
    expect(validatePasswordPolicy('blue-tiger-river-42', { email: 'a@b.co', name: 'Al' })).toEqual(
      [],
    );
  });

  it('uses the given detail path', () => {
    expect(validatePasswordPolicy('short', {}, 'newPassword')[0]?.path).toBe('newPassword');
  });
});

describe('hmac helpers', () => {
  it('produces stable HMACs and compares in constant time', () => {
    const a = hmacToken('token-1');
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(hmacToken('token-1')).toBe(a);
    expect(safeEqualHex(a, hmacToken('token-1'))).toBe(true);
    expect(safeEqualHex(a, hmacToken('token-2'))).toBe(false);
    expect(safeEqualHex(a, 'abcd')).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
    expect(sha256Hex('x')).toHaveLength(64);
  });

  it('generates random tokens and 6-digit OTPs', () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(randomToken());
    for (let i = 0; i < 200; i += 1) expect(randomOtp()).toMatch(/^\d{6}$/);
  });
});

describe('access tokens', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips the claims with iss/aud/exp', async () => {
    const { token, expiresAt } = await signAccessToken({ ...claims, imp: 'admin1' }, '15m');
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(await verifyAccessToken(token)).toEqual({
      ...claims,
      imp: 'admin1',
      exp: Math.floor(expiresAt.getTime() / 1000),
    });
  });

  it('reports an expired token as AUTH_TOKEN_EXPIRED', async () => {
    const { token } = await signAccessToken(claims, '1m');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await expect(verifyAccessToken(token)).rejects.toMatchObject({ code: 'AUTH_TOKEN_EXPIRED' });
  });

  it('rejects tampered, foreign, alg-none and incomplete tokens as AUTH_UNAUTHENTICATED', async () => {
    const { token } = await signAccessToken(claims, '15m');
    const [h, p, s] = token.split('.');
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, acc: 'other' })).toString('base64url')}.${s}`;
    const foreign = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('another-secret-another-secret-123'));
    const unsecured = new UnsecuredJWT({ ...claims })
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setExpirationTime('5m')
      .encode();
    const key = new TextEncoder().encode(getAuthSecrets().access);
    const wrongAud = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience('other')
      .setExpirationTime('5m')
      .sign(key);
    const missing = await new SignJWT({ acc: 'a' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u')
      .setIssuer(ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setExpirationTime('5m')
      .sign(key);
    for (const bad of [tampered, foreign, unsecured, wrongAud, missing, 'garbage', `${h}.${p}`]) {
      await expect(verifyAccessToken(bad)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
    }
  });
});
