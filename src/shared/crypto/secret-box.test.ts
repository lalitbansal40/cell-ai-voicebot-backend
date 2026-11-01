import { createCipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  isSealedWithCurrent,
  keyIdOf,
  open,
  seal,
  SecretBoxError,
  secretBoxKey,
  secretHint,
  secretKeys,
} from './secret-box';

const key = secretBoxKey({
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  NODE_ENV: 'test',
});

const v1Seal = (derived: Buffer, plain: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), data]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64')))
    .join(':');
};

describe('key rotation', () => {
  const oldMaterial = Buffer.alloc(32, 1).toString('base64');
  const newMaterial = Buffer.alloc(32, 2).toString('base64');
  const before = secretKeys({ ENCRYPTION_KEY: oldMaterial, NODE_ENV: 'test' });
  const during = secretKeys({
    ENCRYPTION_KEY: newMaterial,
    ENCRYPTION_KEYS_OLD: ` ${oldMaterial} ,`,
    NODE_ENV: 'test',
  });

  it('writes v2 with the id of the current key', () => {
    const parts = seal(during, 'x').split(':');
    expect(parts).toHaveLength(5);
    expect(parts[1]).toBe(keyIdOf(during.current));
    expect(parts[1]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('opens old v2 and old v1 values with the old key', () => {
    expect(open(during, seal(before, 'old v2'))).toBe('old v2');
    expect(open(during, v1Seal(before.current, 'old v1'))).toBe('old v1');
    expect(open(before, v1Seal(before.current, 'same key v1'))).toBe('same key v1');
  });

  it('names the problem when a key is gone', () => {
    const after = secretKeys({ ENCRYPTION_KEY: newMaterial, NODE_ENV: 'test' });
    expect(() => open(after, seal(before, 'x'))).toThrow(/not configured/);
    expect(() => open(after, v1Seal(before.current, 'x'))).toThrow(SecretBoxError);
  });

  it('knows which values are on the current key', () => {
    expect(isSealedWithCurrent(during, seal(during, 'x'))).toBe(true);
    expect(isSealedWithCurrent(during, seal(before, 'x'))).toBe(false);
    expect(isSealedWithCurrent(during, v1Seal(during.current, 'x'))).toBe(false);
  });

  it('a plain Buffer still works as one key', () => {
    const raw = Buffer.alloc(32, 9);
    expect(open(raw, seal(raw, 'x'))).toBe('x');
    expect(isSealedWithCurrent(raw, seal(raw, 'x'))).toBe(true);
  });
});

describe('secret box', () => {
  it('seals and opens, with a fresh IV every time', () => {
    const a = seal(key, 'Bearer abc-123');
    const b = seal(key, 'Bearer abc-123');
    expect(a).not.toBe(b);
    expect(a.startsWith('v2:')).toBe(true);
    expect(a).not.toContain('abc-123');
    expect(open(key, a)).toBe('Bearer abc-123');
    expect(open(key, seal(key, ''))).toBe('');
    expect(open(key, seal(key, 'नमस्ते ✓'))).toBe('नमस्ते ✓');
  });

  it('refuses tampered values, a wrong key and unknown formats', () => {
    const sealed = seal(key, 'secret');
    const parts = sealed.split(':');
    const flipped = Buffer.from(parts[4] ?? '', 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      open(key, [parts[0], parts[1], parts[2], parts[3], flipped.toString('base64')].join(':')),
    ).toThrow(SecretBoxError);
    const other = secretBoxKey({
      ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
      NODE_ENV: 'test',
    });
    expect(() => open(other, sealed)).toThrow('not configured');
    for (const bad of ['v2:a:b:c', 'v1:a:b', `${sealed}:extra`, 'plain']) {
      expect(() => open(key, bad)).toThrow('Unknown secret format');
    }
  });

  it('derives a key per ENCRYPTION_KEY, separate from storage signing; dev fallback warns', () => {
    expect(key.current).toHaveLength(32);
    const warn = vi.fn();
    const dev = secretBoxKey({ ENCRYPTION_KEY: undefined, NODE_ENV: 'development' }, {
      warn,
    } as never);
    expect(dev.current).toHaveLength(32);
    expect(dev.current.equals(key.current)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(
      secretBoxKey({ ENCRYPTION_KEY: undefined, NODE_ENV: 'test' }).current.equals(dev.current),
    ).toBe(true);
    expect(() => secretBoxKey({ ENCRYPTION_KEY: undefined, NODE_ENV: 'production' })).toThrow(
      'ENCRYPTION_KEY is required',
    );
  });

  it('hints with the last 4 characters only', () => {
    expect(secretHint('sk-live-abcdef1234')).toBe('••••1234');
    expect(secretHint('ab')).toBe('••••ab');
  });
});
