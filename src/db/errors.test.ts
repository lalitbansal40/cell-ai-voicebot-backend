import { describe, expect, it } from 'vitest';

import { isDuplicateKeyError } from './errors';

describe('isDuplicateKeyError', () => {
  it('detects MongoDB E11000 only', () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError({ code: 11001 })).toBe(false);
    expect(isDuplicateKeyError(new Error('x'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError('E11000')).toBe(false);
  });
});
