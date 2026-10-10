import { describe, expect, it } from 'vitest';

import { evaluateCondition, pickRule } from './conditions';

describe('conditions', () => {
  it.each<
    [
      Parameters<typeof evaluateCondition>[0],
      Parameters<typeof evaluateCondition>[1],
      string | null,
      boolean,
    ]
  >([
    ['equals', 'Paid', 'paid', true],
    ['equals', ' paid ', 'paid', true],
    ['equals', 10, '10.0', true],
    ['equals', '10', '9', false],
    ['equals', null, '', true],
    ['not_equals', 'paid', 'unpaid', true],
    ['not_equals', 5, '5', false],
    ['contains', 'Payment done', 'DONE', true],
    ['contains', null, 'x', false],
    ['not_contains', 'abc', 'x', true],
    ['starts_with', 'Hello there', 'hello', true],
    ['gt', '10', '9', true],
    ['gt', 'ten', '9', false],
    ['gte', 9, '9', true],
    ['lt', 3, '4', true],
    ['lte', 4, '4', true],
    ['lte', 4, 'x', false],
    ['is_empty', null, null, true],
    ['is_empty', '  ', null, true],
    ['is_empty', 0, null, false],
    ['is_not_empty', 'x', null, true],
    ['in_list', 'Paid', 'unpaid, PAID ,partial', true],
    ['in_list', 'x', ',,', false],
    ['date_before', '2026-10-10', '2026-10-11', true],
    ['date_before', '2026-10-12', '2026-10-11', false],
    ['date_after', '2026-10-12', '2026-10-11', true],
    ['date_after', 'tomorrow', '2026-10-11', false],
    ['date_after', 5, '2026-10-11', false],
    ['equals', 'x', null, false],
  ])('%s(%j, %j) = %s', (op, left, right, expected) => {
    expect(evaluateCondition(op, left, right)).toBe(expected);
  });

  it('picks the first matching rule (all / any), else', () => {
    const values: Record<string, string | number | null> = { status: 'unpaid', amount: 500 };
    const resolve = (c: { variable: string; value: string | null }) => ({
      left: values[c.variable] ?? null,
      right: c.value,
    });
    const rules = [
      {
        id: 'r1',
        match: 'all' as const,
        conditions: [{ variable: 'status', operator: 'equals' as const, value: 'paid' }],
      },
      {
        id: 'r2',
        match: 'any' as const,
        conditions: [
          { variable: 'status', operator: 'equals' as const, value: 'paid' },
          { variable: 'amount', operator: 'gt' as const, value: '100' },
        ],
      },
      {
        id: 'r3',
        match: 'all' as const,
        conditions: [{ variable: 'amount', operator: 'gt' as const, value: '1' }],
      },
    ];
    expect(pickRule(rules, resolve)).toBe('rule_r2');
    values.amount = 50;
    expect(pickRule(rules, resolve)).toBe('rule_r3');
    values.amount = 0;
    expect(pickRule(rules, resolve)).toBe('else');
    expect(pickRule([], resolve)).toBe('else');
  });
});
