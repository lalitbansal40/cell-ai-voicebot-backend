import { describe, expect, it } from 'vitest';

import { redactArgs, redactPreview, redactText } from './redact';

describe('redaction', () => {
  it('masks phone-like numbers and e-mail local parts', () => {
    expect(redactText('Call +91 90000 00001 or asha.verma@example.com')).toBe(
      'Call ••••0001 or •••@example.com',
    );
    expect(redactText('loan 12345, amount 2500')).toBe('loan 12345, amount 2500');
    expect(redactText('id 9876543210')).toBe('id ••••3210');
  });

  it('redacts argument values and cuts long ones', () => {
    expect(
      redactArgs({
        phone: '+919000000001',
        n: 5,
        ok: true,
        none: null,
        nested: { mobile: '9000000001' },
        long: 'a'.repeat(300),
      }),
    ).toEqual({
      phone: '••••0001',
      n: 5,
      ok: true,
      none: null,
      nested: '{"mobile":"••••0001"}',
      long: 'a'.repeat(200),
    });
  });

  it('previews at most 500 chars', () => {
    expect(redactPreview('x'.repeat(900))).toHaveLength(500);
  });
});
