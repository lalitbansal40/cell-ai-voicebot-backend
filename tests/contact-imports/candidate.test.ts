import { describe, expect, it } from 'vitest';

import {
  applyRequired,
  buildCandidate,
  type FieldInfo,
} from '../../src/modules/contact-imports/candidate';
import {
  buildErrorReport,
  describeReason,
  safeCell,
} from '../../src/modules/contact-imports/error-report';
import type { ColumnMapping } from '../../src/modules/contact-imports/mapping';

const fields = new Map<string, FieldInfo>([
  ['loan_amount', { type: 'currency', required: true }],
  ['branch', { type: 'text', required: false, defaultValue: 'Pune' }],
  ['due', { type: 'date', required: false }],
]);
const columns: ColumnMapping[] = [
  { index: 0, target: 'phone' },
  { index: 1, target: 'name' },
  { index: 2, target: 'email' },
  { index: 3, target: 'external_id' },
  { index: 4, target: 'tags' },
  { index: 5, target: 'consent_at', dateFormat: 'DMY' },
  { index: 6, target: 'field', key: 'loan_amount' },
  { index: 7, target: 'new_field', key: 'due', label: 'Due', type: 'date', dateFormat: 'MDY' },
  { index: 8, target: 'field', key: 'gone' },
  { index: 9, target: 'ignore' },
  { index: 10, target: 'reason' },
];
const build = (cells: string[]) =>
  buildCandidate({ rowNumber: 2, cells }, columns, fields, { country: 'IN' });

describe('buildCandidate', () => {
  it('normalises every target', () => {
    expect(
      build([
        '98765 43210',
        ' Asha ',
        'A@Example.com',
        'LN-1',
        'VIP;x',
        '01/10/2026',
        '₹1,000',
        '10/05/2026',
        'z',
        'skip',
        'asked',
      ]),
    ).toEqual({
      rowNumber: 2,
      phoneE164: '+919876543210',
      name: 'Asha',
      email: 'a@example.com',
      externalId: 'LN-1',
      tags: ['vip', 'x'],
      consentAt: '2026-10-01',
      reason: 'asked',
      variables: { loan_amount: 1_000_000_000, due: '2026-10-05' },
      reasons: [],
    });
  });

  it('collects reasons and skips empty cells', () => {
    const c = build([
      '123',
      '',
      'nope',
      '',
      'bad#',
      '31/02/2026',
      'lots',
      'x'.repeat(5),
      '',
      '',
      '',
    ]);
    expect(c.reasons).toEqual([
      'phone_invalid',
      'email_invalid',
      'tags_invalid',
      'type_invalid:consent_at',
      'type_invalid:loan_amount',
      'type_invalid:due',
    ]);
    expect(c).not.toHaveProperty('name');
    expect(build([]).reasons).toEqual(['phone_missing']);
  });
});

describe('applyRequired', () => {
  const candidate = build(['9876543210']);
  it('fills defaults for new contacts and reports missing required', () => {
    expect(applyRequired(candidate, fields, undefined)).toEqual({
      variables: { branch: 'Pune' },
      reasons: ['missing_required:loan_amount'],
    });
  });
  it('merges with existing values (no defaults on updates)', () => {
    expect(applyRequired(candidate, fields, { loan_amount: 5 })).toEqual({
      variables: { loan_amount: 5 },
      reasons: [],
    });
  });
});

describe('error report', () => {
  it.each([
    ['phone_missing', 'Phone is missing'],
    ['email_invalid', 'E-mail is not valid'],
    ['tags_invalid', 'Tags are not valid'],
    ['type_invalid:due', 'due: wrong format'],
    ['too_long:note', 'note: too long'],
    ['missing_required:loan_amount', 'loan_amount: required'],
    ['duplicate_of_row:7', 'Same phone as row 7'],
    ['something_new', 'something_new'],
  ])('%s', (reason, text) => {
    expect(describeReason(reason)).toBe(text);
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+91 98765', "'+91 98765"],
    ['-2', "'-2"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tx', "'\tx"],
    ['\rx', "'\rx"],
    ['Asha', 'Asha'],
  ])('safeCell(%j)', (value, safe) => {
    expect(safeCell(value)).toBe(safe);
  });

  it('writes a BOM, the original cells and readable reasons', () => {
    const csv = buildErrorReport(
      ['Name', 'Phone'],
      [{ rowNumber: 3, cells: ['=cmd', ''], reasons: ['phone_missing', 'x'] }],
    ).toString();
    expect(csv).toBe("﻿row,Name,Phone,reasons\r\n3,'=cmd,,Phone is missing; x\r\n");
  });
});
