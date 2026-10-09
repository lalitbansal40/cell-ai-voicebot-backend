import { describe, expect, it } from 'vitest';

import { ValidationError } from '../errors/app-error';

import { decodeCursor, encodeCursor } from './cursor';

const raw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('time cursor', () => {
  it('round-trips', () => {
    const c = { at: '2026-10-09T00:00:00.000Z', id: 'a'.repeat(24) };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it.each([
    'not-base64-json',
    raw({ at: 5, id: 'a'.repeat(24) }),
    raw({ at: '2026-10-09', id: 'xyz' }),
    raw({ at: 'not a date', id: 'a'.repeat(24) }),
  ])('rejects %s', (value) => {
    expect(() => decodeCursor(value)).toThrow(ValidationError);
  });
});
