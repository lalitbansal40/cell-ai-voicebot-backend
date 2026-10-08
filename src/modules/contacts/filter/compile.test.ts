import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { FieldType } from '../../../db/models/custom-field.model';

import { compileContactFilter, compileOrThrow, isoDay, type CompileContext } from './compile';
import type { ContactFilter, FilterCondition } from './filter.schema';

const accountId = new Types.ObjectId();
const fields = new Map<string, { type: FieldType }>([
  ['branch', { type: 'text' }],
  ['days_past_due', { type: 'number' }],
  ['loan_amount', { type: 'currency' }],
  ['due_date', { type: 'date' }],
  ['alt_phone', { type: 'phone' }],
]);
// 2026-10-08 20:00 UTC = 2026-10-09 01:30 in Asia/Kolkata
const now = new Date('2026-10-08T20:00:00Z');
const ctx: CompileContext = { fields, timezone: 'Asia/Kolkata', country: 'IN', now };

const one = (cond: FilterCondition) => {
  const { query, problems } = compileContactFilter(accountId, { conditions: [cond] }, ctx);
  expect(problems).toEqual([]);
  return (query.$and as Record<string, unknown>[])[0];
};
const problemOf = (filter: ContactFilter) => compileContactFilter(accountId, filter, ctx);

describe('compileContactFilter', () => {
  it('always scopes to the account and live contacts', () => {
    expect(compileContactFilter(accountId, {}, ctx)).toEqual({
      query: { accountId, deletedAt: null },
      problems: [],
    });
  });

  it.each([
    [{ key: 'branch', op: 'eq', value: 'Pune' }, { 'variables.branch': 'Pune' }],
    [{ key: 'branch', op: 'neq', value: 'Pune' }, { 'variables.branch': { $ne: 'Pune' } }],
    [
      { key: 'branch', op: 'contains', value: 'pu.n' },
      { 'variables.branch': { $regex: 'pu\\.n', $options: 'i' } },
    ],
    [{ key: 'branch', op: 'exists' }, { 'variables.branch': { $exists: true } }],
    [{ key: 'branch', op: 'not_exists' }, { 'variables.branch': { $exists: false } }],
    [{ key: 'days_past_due', op: 'gt', value: '30' }, { 'variables.days_past_due': { $gt: 30 } }],
    [{ key: 'days_past_due', op: 'gte', value: 30 }, { 'variables.days_past_due': { $gte: 30 } }],
    [{ key: 'days_past_due', op: 'lt', value: 5 }, { 'variables.days_past_due': { $lt: 5 } }],
    [{ key: 'days_past_due', op: 'lte', value: 5 }, { 'variables.days_past_due': { $lte: 5 } }],
    [
      { key: 'days_past_due', op: 'between', value: 30, value2: '60' },
      { 'variables.days_past_due': { $gte: 30, $lte: 60 } },
    ],
    [
      { key: 'loan_amount', op: 'gte', value: '₹10,000.50' },
      { 'variables.loan_amount': { $gte: 10_000_500_000 } },
    ],
    [{ key: 'due_date', op: 'on', value: '2026-10-05' }, { 'variables.due_date': '2026-10-05' }],
    [
      { key: 'due_date', op: 'before', value: '05/10/2026' },
      { 'variables.due_date': { $lt: '2026-10-05' } },
    ],
    [
      { key: 'due_date', op: 'after', value: '2026-10-05' },
      { 'variables.due_date': { $gt: '2026-10-05' } },
    ],
    [
      { key: 'due_date', op: 'within_next_days', value: 7 },
      { 'variables.due_date': { $gte: '2026-10-09', $lte: '2026-10-16' } },
    ],
    [
      { key: 'due_date', op: 'overdue_by_days', value: '30' },
      { 'variables.due_date': { $lte: '2026-09-09' } },
    ],
    [
      { key: 'alt_phone', op: 'eq', value: '98765 43210' },
      { 'variables.alt_phone': '+919876543210' },
    ],
  ] as [FilterCondition, Record<string, unknown>][])('%j', (cond, clause) => {
    expect(one(cond)).toEqual(clause);
  });

  it.each([
    [{ key: 'nope', op: 'eq', value: 'x' }, 'conditions.0.key'],
    [{ key: 'branch', op: 'gt', value: 'x' }, 'conditions.0.op'],
    [{ key: 'alt_phone', op: 'contains', value: '98' }, 'conditions.0.op'],
    [{ key: 'branch', op: 'eq' }, 'conditions.0.value'],
    [{ key: 'days_past_due', op: 'gt', value: 'many' }, 'conditions.0.value'],
    [{ key: 'loan_amount', op: 'eq', value: '1.005' }, 'conditions.0.value'],
    [{ key: 'due_date', op: 'on', value: '31/02/2026' }, 'conditions.0.value'],
    [{ key: 'due_date', op: 'within_next_days', value: -1 }, 'conditions.0.value'],
    [{ key: 'due_date', op: 'overdue_by_days', value: 'x' }, 'conditions.0.value'],
    [{ key: 'alt_phone', op: 'eq', value: '123' }, 'conditions.0.value'],
    [{ key: 'days_past_due', op: 'between', value: 1 }, 'conditions.0.value2'],
  ] as [FilterCondition, string][])('%j → problem at %s; matches nothing', (cond, path) => {
    const { query, problems } = problemOf({ conditions: [cond] });
    expect(problems.map((p) => p.path)).toEqual([path]);
    expect(query).toEqual({ accountId, deletedAt: null, _id: { $in: [] } });
  });

  it('compiles lists, tags (any / all), flags and the created range', () => {
    const listId = new Types.ObjectId().toString();
    const { query } = compileContactFilter(
      accountId,
      {
        listIds: [listId],
        tags: { mode: 'all', values: ['VIP', ' overdue '] },
        dnd: false,
        optedOut: true,
        createdFrom: '2026-10-01',
        createdTo: '2026-10-08T00:00:00Z',
      },
      ctx,
    );
    expect(query.$and).toEqual([
      { listIds: { $in: [new Types.ObjectId(listId)] } },
      { tags: { $all: ['vip', 'overdue'] } },
      { dnd: false },
      { optedOutAt: { $ne: null } },
      {
        createdAt: {
          $gte: new Date('2026-10-01'),
          $lt: new Date('2026-10-08T00:00:00Z'),
        },
      },
    ]);
    const any = compileContactFilter(
      accountId,
      { tags: { mode: 'any', values: ['vip'] }, optedOut: false, createdTo: '2026-10-08' },
      ctx,
    );
    expect(any.query.$and).toEqual([
      { tags: { $in: ['vip'] } },
      { optedOutAt: null },
      { createdAt: { $lt: new Date('2026-10-08') } },
    ]);
    expect(problemOf({ tags: { mode: 'any', values: ['bad#'] } }).problems[0]?.path).toBe(
      'tags.values',
    );
  });

  it('searches text and, for phone-like input, the phone digits too', () => {
    expect(compileContactFilter(accountId, { q: 'Asha  (Verma)' }, ctx).query.$and).toEqual([
      { searchText: { $regex: 'asha \\(verma\\)' } },
    ]);
    expect(compileContactFilter(accountId, { q: '+91 98765-43210' }, ctx).query.$and).toEqual([
      {
        $or: [
          { searchText: { $regex: '\\+91 98765-43210' } },
          { searchText: { $regex: '919876543210' } },
        ],
      },
    ]);
    expect(compileContactFilter(accountId, { q: '098761' }, ctx).query.$and).toEqual([
      { $or: [{ searchText: { $regex: '098761' } }, { searchText: { $regex: '98761' } }] },
    ]);
    expect(compileContactFilter(accountId, { q: '0091 98761' }, ctx).query.$and).toEqual([
      { $or: [{ searchText: { $regex: '0091 98761' } }, { searchText: { $regex: '9198761' } }] },
    ]);
    expect(compileContactFilter(accountId, { q: '98' }, ctx).query.$and).toEqual([
      { searchText: { $regex: '98' } },
    ]);
  });

  it('throws 422 with prefixed paths in strict mode', () => {
    expect(() =>
      compileOrThrow(accountId, { conditions: [{ key: 'nope', op: 'eq', value: 1 }] }, ctx),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }) as Error);
    try {
      compileOrThrow(accountId, { conditions: [{ key: 'nope', op: 'eq', value: 1 }] }, ctx, '');
    } catch (err) {
      expect((err as { details: { path: string }[] }).details[0]?.path).toBe('conditions.0.key');
    }
    expect(compileOrThrow(accountId, {}, ctx)).toEqual({ accountId, deletedAt: null });
  });
});

describe('isoDay', () => {
  it('uses the calendar day of the timezone', () => {
    expect(isoDay(now, 'Asia/Kolkata')).toBe('2026-10-09');
    expect(isoDay(now, 'UTC')).toBe('2026-10-08');
    expect(isoDay(now, 'Asia/Kolkata', 30)).toBe('2026-11-08');
    expect(isoDay(now, 'Asia/Kolkata', -40)).toBe('2026-08-30');
  });

  it('defaults "now" to the current time', () => {
    const { problems } = compileContactFilter(
      accountId,
      { conditions: [{ key: 'due_date', op: 'within_next_days', value: 1 }] },
      { ...ctx, now: undefined },
    );
    expect(problems).toEqual([]);
  });
});
