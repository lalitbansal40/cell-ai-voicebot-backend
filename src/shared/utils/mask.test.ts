import { describe, expect, it } from 'vitest';

import { maskEmail, maskPhone } from './mask';

describe('maskPhone', () => {
  it('keeps country code prefix and last 4 digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });

  it('ignores formatting characters', () => {
    expect(maskPhone('+91 98765-43210')).toBe('+91******3210');
  });

  it('fully masks very short values', () => {
    expect(maskPhone('12345')).toBe('*****');
  });
});

describe('maskEmail', () => {
  it('keeps the first letter and domain', () => {
    expect(maskEmail('lalit@example.com')).toBe('l***@example.com');
  });

  it('masks invalid emails completely', () => {
    expect(maskEmail('nope')).toBe('***');
  });
});
