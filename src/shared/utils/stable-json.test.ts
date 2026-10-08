import { describe, expect, it } from 'vitest';

import { hashRequest, stableJson } from './stable-json';

describe('stableJson', () => {
  it('ignores key order (recursively)', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } })).toBe(
      stableJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }),
    );
  });

  it('drops undefined values and keeps array order', () => {
    expect(stableJson({ a: undefined, b: [2, 1] })).toBe('{"b":[2,1]}');
  });

  it('serialises dates as ISO strings', () => {
    expect(stableJson({ at: new Date('2026-01-01T00:00:00Z') })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z"}',
    );
  });
});

describe('hashRequest', () => {
  it('differs by method, path and body; not by key order', () => {
    const base = hashRequest('POST', '/a', { x: 1, y: 2 });
    expect(hashRequest('post', '/a', { y: 2, x: 1 })).toBe(base);
    expect(hashRequest('PUT', '/a', { x: 1, y: 2 })).not.toBe(base);
    expect(hashRequest('POST', '/b', { x: 1, y: 2 })).not.toBe(base);
    expect(hashRequest('POST', '/a', { x: 2, y: 2 })).not.toBe(base);
  });
});
