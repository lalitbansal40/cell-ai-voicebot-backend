import { describe, expect, it } from 'vitest';

import { applyDefaultsAndRequired } from './defaults';
import { normalizeEmail } from './email';
import { buildSearchText } from './search-text';
import { normalizeTag, normalizeTags } from './tags';

describe('normalizeTags', () => {
  it.each([
    ['VIP; overdue, VIP', ['vip', 'overdue']],
    [['  Hot  Lead ', 'hot lead'], ['hot lead']],
    ['नया', ['नया']],
    ['due_30-60', ['due_30-60']],
    ['', []],
    [null, []],
    [', ;', []],
  ])('%j → %j', (input, tags) => {
    expect(normalizeTags(input)).toEqual({ ok: true, tags });
  });

  it.each([
    ['bad#tag'],
    ['x'.repeat(41)],
    [Array.from({ length: 21 }, (_, i) => `t${i}`)],
    [[1]],
    [42],
  ])('%j → tags_invalid', (input) => {
    expect(normalizeTags(input)).toEqual({ ok: false, reason: 'tags_invalid' });
  });

  it('normalises a single tag', () => {
    expect(normalizeTag(' VIP ')).toBe('vip');
    expect(normalizeTag('a,b')).toBeUndefined();
    expect(normalizeTag('#')).toBeUndefined();
  });
});

describe('normalizeEmail', () => {
  it.each([
    [' Asha@Example.COM ', { ok: true, value: 'asha@example.com' }],
    ['', { ok: true, value: undefined }],
    [null, { ok: true, value: undefined }],
    ['not-an-email', { ok: false, reason: 'email_invalid' }],
    [42, { ok: false, reason: 'email_invalid' }],
  ])('%j', (raw, result) => {
    expect(normalizeEmail(raw)).toEqual(result);
  });
});

describe('buildSearchText', () => {
  it('joins name, email, phone digits and external id in lower case', () => {
    expect(
      buildSearchText({
        name: 'Asha Verma',
        email: 'asha@example.com',
        phoneE164: '+919876543210',
        externalId: 'LN-77',
      }),
    ).toBe('asha verma asha@example.com 919876543210 ln-77');
    expect(buildSearchText({ phoneE164: '+919876543210', name: null })).toBe('919876543210');
  });
});

describe('applyDefaultsAndRequired', () => {
  const fields = [
    { key: 'loan_amount', required: true, defaultValue: null },
    { key: 'branch', required: false, defaultValue: 'Pune' },
    { key: 'bucket', required: true, defaultValue: 'B1' },
    { key: 'notes', required: false },
  ];

  it('fills defaults on create and lists missing required keys', () => {
    expect(applyDefaultsAndRequired(fields, {}, { applyDefaults: true })).toEqual({
      variables: { branch: 'Pune', bucket: 'B1' },
      missing: ['loan_amount'],
    });
  });

  it('never applies defaults on update', () => {
    expect(applyDefaultsAndRequired(fields, { loan_amount: 5 }, { applyDefaults: false })).toEqual({
      variables: { loan_amount: 5 },
      missing: ['bucket'],
    });
  });
});
