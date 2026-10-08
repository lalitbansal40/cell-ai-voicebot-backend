import { describe, expect, it } from 'vitest';

import {
  guessType,
  slugKey,
  suggestMapping,
  validateMapping,
  type ColumnMapping,
} from '../../src/modules/contact-imports/mapping';

const col = (index: number, header: string, samples: string[] = []) => ({ index, header, samples });

describe('suggestMapping', () => {
  it('maps Hinglish / common headers, existing fields and proposes typed new fields', () => {
    const fields = [
      { key: 'loan_amount', label: 'Loan amount', type: 'currency' as const },
      { key: 'due_date', label: 'Due date', type: 'date' as const },
    ];
    const result = suggestMapping(
      'contacts',
      [
        col(0, 'Naam'),
        col(1, 'Mobile No.', ['9876543210']),
        col(2, 'E-mail ID'),
        col(3, 'Loan A/c No'),
        col(4, 'Loan Amount'),
        col(5, 'Due Date'),
        col(6, 'DPD', ['45', '3']),
        col(7, 'EMI Amt', ['1,200', '900']),
        col(8, 'Next Visit', ['05/10/2026', '06-Oct-2026']),
        col(9, 'Alt Phone', ['+91 98765 43211']),
        col(10, 'Branch', ['Pune']),
        col(11, 'Phone'),
        col(12, 'Tags'),
        col(13, '2nd Note'),
        col(14, 'Name'),
      ],
      fields,
    );
    expect(result).toEqual([
      { index: 0, target: 'name' },
      { index: 1, target: 'phone' },
      { index: 2, target: 'email' },
      { index: 3, target: 'new_field', key: 'loan_a_c_no', label: 'Loan A/c No', type: 'text' },
      { index: 4, target: 'field', key: 'loan_amount' },
      { index: 5, target: 'field', key: 'due_date', dateFormat: 'DMY' },
      { index: 6, target: 'new_field', key: 'dpd', label: 'DPD', type: 'number' },
      { index: 7, target: 'new_field', key: 'emi_amt', label: 'EMI Amt', type: 'currency' },
      {
        index: 8,
        target: 'new_field',
        key: 'next_visit',
        label: 'Next Visit',
        type: 'date',
        dateFormat: 'DMY',
      },
      { index: 9, target: 'new_field', key: 'alt_phone', label: 'Alt Phone', type: 'phone' },
      { index: 10, target: 'new_field', key: 'branch', label: 'Branch', type: 'text' },
      { index: 11, target: 'new_field', key: 'phone_value', label: 'Phone', type: 'text' },
      { index: 12, target: 'tags' },
      { index: 13, target: 'new_field', key: 'f_2nd_note', label: '2nd Note', type: 'text' },
      { index: 14, target: 'new_field', key: 'name_value', label: 'Name', type: 'text' },
    ]);
  });

  it('avoids key clashes and handles DND files', () => {
    const r = suggestMapping(
      'contacts',
      [col(0, 'Branch'), col(1, 'branch!')],
      [{ key: 'branch', label: 'Other', type: 'text' }],
    );
    expect(r.map((m) => m.key)).toEqual(['branch', 'branch_2']);
    expect(r[0]?.target).toBe('field');
    expect(
      suggestMapping(
        'dnd',
        [col(0, 'Mobile'), col(1, 'Remarks'), col(2, 'Name'), col(3, 'Phone')],
        [],
      ),
    ).toEqual([
      { index: 0, target: 'phone' },
      { index: 1, target: 'reason' },
      { index: 2, target: 'ignore' },
      { index: 3, target: 'ignore' },
    ]);
  });

  it('slugs keys and guesses types', () => {
    expect(slugKey('Loan Amt (Rs)')).toBe('loan_amt_rs');
    expect(slugKey('!!!')).toBe('field');
    expect(slugKey('x'.repeat(60))).toHaveLength(40);
    expect(guessType('Anything', [])).toBe('text');
    expect(guessType('Amount', ['₹100', 'Rs 50'])).toBe('currency');
    expect(guessType('Paid', ['₹100', 'Rs 50', 'no', 'x', 'y'])).toBe('text');
  });
});

describe('validateMapping', () => {
  const fields = [{ key: 'loan_amount', type: 'currency' as const }];
  const ok: ColumnMapping[] = [
    { index: 0, target: 'phone' },
    { index: 1, target: 'field', key: 'loan_amount' },
    { index: 2, target: 'new_field', key: 'branch', label: 'Branch', type: 'text' },
    { index: 3, target: 'ignore' },
  ];

  it('accepts a valid mapping', () => {
    expect(validateMapping('contacts', { columns: ok }, 4, fields)).toEqual([]);
  });

  it.each([
    [[{ index: 0, target: 'name' }], 'columns'],
    [[{ index: 9, target: 'phone' }], 'columns.0.index'],
    [
      [
        { index: 0, target: 'phone' },
        { index: 0, target: 'name' },
      ],
      'columns.1.index',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'phone' },
      ],
      'columns.1.target',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'field', key: 'nope' },
      ],
      'columns.1.key',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'new_field', key: 'Bad Key', label: 'x', type: 'text' },
      ],
      'columns.1.key',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'new_field', key: 'email', label: 'x', type: 'text' },
      ],
      'columns.1.key',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'new_field', key: 'loan_amount', label: 'x', type: 'text' },
      ],
      'columns.1.key',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'new_field', key: 'k', label: ' ', type: 'text' },
      ],
      'columns.1.label',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'new_field', key: 'k', label: 'K' },
      ],
      'columns.1.type',
    ],
    [
      [
        { index: 0, target: 'phone' },
        { index: 1, target: 'reason' },
      ],
      'columns.1.target',
    ],
  ] as [ColumnMapping[], string][])('%j → %s', (columns, path) => {
    expect(validateMapping('contacts', { columns }, 4, fields).map((e) => e.path)).toContain(path);
  });

  it('limits DND targets and total fields', () => {
    expect(
      validateMapping(
        'dnd',
        {
          columns: [
            { index: 0, target: 'phone' },
            { index: 1, target: 'name' },
          ],
        },
        2,
        [],
      ).map((e) => e.path),
    ).toEqual(['columns.1.target']);
    const many = Array.from({ length: 50 }, (_, i) => ({ key: `f${i}`, type: 'text' as const }));
    expect(
      validateMapping(
        'contacts',
        {
          columns: [
            { index: 0, target: 'phone' },
            { index: 1, target: 'new_field', key: 'k', label: 'K', type: 'text' },
          ],
        },
        2,
        many,
      ).map((e) => e.message),
    ).toContain('An account can have at most 50 custom fields');
  });
});
