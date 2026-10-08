import { describe, expect, it } from 'vitest';

import { RESERVED_SLUGS, slugify } from './slug';

describe('slugify', () => {
  it.each([
    ['Demo Finance Pvt. Ltd.', 'demo-finance-pvt-ltd'],
    ['  Çafé   Delhi!! ', 'cafe-delhi'],
    ['---', 'account'],
    ['रामा फाइनेंस', 'account'],
    ['A'.repeat(60), 'a'.repeat(40)],
    ['abc-'.repeat(15), 'abc-abc-abc-abc-abc-abc-abc-abc-abc-abc'],
  ])('%s → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('reserves platform slugs', () => {
    expect(RESERVED_SLUGS.has('platform')).toBe(true);
  });
});
