import { describe, expect, it } from 'vitest';

import {
  CoercionError,
  SYSTEM_VARIABLE_NAMES,
  buildVariableCatalog,
  coerce,
  displayValue,
  flowTemplate,
  isYmd,
  readableDate,
} from './variables';

describe('variable catalogue', () => {
  it('lists contact (read-only), flow (writable) and system (read-only) variables', () => {
    const catalog = buildVariableCatalog({
      contactVars: [{ name: 'amount', label: 'Amount', type: 'currency' }],
      flowVars: [
        { name: 'tries', type: 'number' },
        { name: 'note', type: 'text', label: 'Note' },
      ],
    });
    expect(catalog.slice(0, 3)).toEqual([
      { name: 'amount', label: 'Amount', type: 'currency', source: 'contact', readOnly: true },
      { name: 'tries', label: 'tries', type: 'number', source: 'flow', readOnly: false },
      { name: 'note', label: 'Note', type: 'text', source: 'flow', readOnly: false },
    ]);
    expect(catalog.filter((v) => v.source === 'system')).toHaveLength(SYSTEM_VARIABLE_NAMES.size);
    expect(SYSTEM_VARIABLE_NAMES.has('promise_date')).toBe(true);
  });
});

describe('coerce', () => {
  it.each<[Parameters<typeof coerce>[0], unknown, unknown]>([
    ['text', '  hi ', 'hi'],
    ['text', 12, '12'],
    ['text', true, 'true'],
    ['text', '', null],
    ['text', null, null],
    ['text', undefined, null],
    ['number', '2500', 2500],
    ['number', '-1.5', -1.5],
    ['number', 7, 7],
    ['boolean', 'Haan', true],
    ['boolean', 'yes', true],
    ['boolean', '1', true],
    ['boolean', 'nahi', false],
    ['boolean', 'No', false],
    ['boolean', false, false],
    ['date', '2026-10-11', '2026-10-11'],
  ])('%s %j → %j', (type, raw, expected) => {
    expect(coerce(type, raw)).toEqual(expected);
  });

  it.each<[Parameters<typeof coerce>[0], unknown]>([
    ['number', '2,500'],
    ['number', 'abc'],
    ['number', Number.NaN],
    ['boolean', 'maybe'],
    ['date', '2026-02-30'],
    ['date', '11-10-2026'],
    ['text', { a: 1 }],
  ])('%s %j throws', (type, raw) => {
    expect(() => coerce(type, raw)).toThrow(CoercionError);
  });
});

describe('display values', () => {
  it('formats per type and language', () => {
    expect(displayValue('currency', 2_500_000_000, 'hinglish')).toBe('₹2,500.00');
    expect(displayValue('number', 125000, 'en')).toBe('1,25,000');
    expect(displayValue('date', '2026-10-11', 'hi')).toBe('11 Oct 2026');
    expect(displayValue('boolean', true, 'en')).toBe('yes');
    expect(displayValue('boolean', false, 'en')).toBe('no');
    expect(displayValue('boolean', true, 'hinglish')).toBe('haan');
    expect(displayValue('boolean', false, 'hi')).toBe('nahi');
    expect(displayValue('text', null, 'en')).toBe('');
    expect(displayValue('text', '', 'en')).toBe('');
    expect(displayValue('text', 'abc', 'en')).toBe('abc');
  });

  it('reads dates only when they are real', () => {
    expect(readableDate('2026-01-05')).toBe('05 Jan 2026');
    expect(readableDate('2026-13-05')).toBe('2026-13-05');
    expect(readableDate('soon')).toBe('soon');
    expect(isYmd('2024-02-29')).toBe(true);
    expect(isYmd('2025-02-29')).toBe(false);
  });
});

describe('flow template', () => {
  const ctx = { values: { name: 'Asha', amount: '₹2,500.00', empty: '' } };

  it('renders flat names and warns on missing ones', () => {
    const warnings = new Set<string>();
    expect(
      flowTemplate.renderText('Hi {{ name }}, {{amount}} {{empty}}{{nope}}', ctx, warnings),
    ).toBe('Hi Asha, ₹2,500.00 ');
    expect([...warnings]).toEqual(['missing:empty', 'missing:nope']);
  });

  it('fills contact.phone / external_id only when the server passes them', () => {
    const warnings = new Set<string>();
    expect(
      flowTemplate.renderUrl(
        'https://x/?p={{contact.phone}}&e={{contact.external_id}}',
        ctx,
        warnings,
      ),
    ).toBe('https://x/?p=&e=');
    expect(warnings.has('missing:contact.phone')).toBe(true);
    const full = { ...ctx, contact: { phone: '+919000000001', external_id: null } };
    expect(flowTemplate.renderUrl('https://x/?p={{contact.phone}}', full, new Set())).toBe(
      'https://x/?p=%2B919000000001',
    );
    expect(flowTemplate.isKnownToken('contact.phone')).toBe(true);
    expect(flowTemplate.isKnownToken('contact.name')).toBe(false);
    expect(flowTemplate.isKnownToken('Name')).toBe(false);
    expect(flowTemplate.renderText('{{constructor}}', ctx, new Set())).toBe('');
  });
});
