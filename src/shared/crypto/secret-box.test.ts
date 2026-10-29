import { describe, expect, it, vi } from 'vitest';

import { open, seal, SecretBoxError, secretBoxKey, secretHint } from './secret-box';

const key = secretBoxKey({
  ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
  NODE_ENV: 'test',
});

describe('secret box', () => {
  it('seals and opens, with a fresh IV every time', () => {
    const a = seal(key, 'Bearer abc-123');
    const b = seal(key, 'Bearer abc-123');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a).not.toContain('abc-123');
    expect(open(key, a)).toBe('Bearer abc-123');
    expect(open(key, seal(key, ''))).toBe('');
    expect(open(key, seal(key, 'नमस्ते ✓'))).toBe('नमस्ते ✓');
  });

  it('refuses tampered values, a wrong key and unknown formats', () => {
    const sealed = seal(key, 'secret');
    const parts = sealed.split(':');
    const flipped = Buffer.from(parts[3] ?? '', 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      open(key, [parts[0], parts[1], parts[2], flipped.toString('base64')].join(':')),
    ).toThrow(SecretBoxError);
    const other = secretBoxKey({
      ENCRYPTION_KEY: Buffer.alloc(32, 4).toString('base64'),
      NODE_ENV: 'test',
    });
    expect(() => open(other, sealed)).toThrow('Secret could not be opened');
    for (const bad of ['v2:a:b:c', 'v1:a:b', `${sealed}:extra`, 'plain']) {
      expect(() => open(key, bad)).toThrow('Unknown secret format');
    }
  });

  it('derives a key per ENCRYPTION_KEY, separate from storage signing; dev fallback warns', () => {
    expect(key).toHaveLength(32);
    const warn = vi.fn();
    const dev = secretBoxKey({ ENCRYPTION_KEY: undefined, NODE_ENV: 'development' }, {
      warn,
    } as never);
    expect(dev).toHaveLength(32);
    expect(dev.equals(key)).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(secretBoxKey({ ENCRYPTION_KEY: undefined, NODE_ENV: 'test' }).equals(dev)).toBe(true);
    expect(() => secretBoxKey({ ENCRYPTION_KEY: undefined, NODE_ENV: 'production' })).toThrow(
      'ENCRYPTION_KEY is required',
    );
  });

  it('hints with the last 4 characters only', () => {
    expect(secretHint('sk-live-abcdef1234')).toBe('••••1234');
    expect(secretHint('ab')).toBe('••••ab');
  });
});
