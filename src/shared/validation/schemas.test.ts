import { describe, expect, it } from 'vitest';

import { z } from '../openapi/zod';

import {
  CursorQuerySchema,
  MoneyMicrosSchema,
  ObjectIdSchema,
  PaginationQuerySchema,
  PhoneE164Schema,
  sortSchema,
  strictQuery,
} from './schemas';
import { zodIssuesToDetails } from './zod-errors';

describe('ObjectIdSchema', () => {
  it('accepts 24 hex chars', () =>
    expect(ObjectIdSchema.parse('66f1c2a9e4b0c1d2e3f4a5b6')).toBeTruthy());
  it.each(['123', 'zzzzzzzzzzzzzzzzzzzzzzzz', '66f1c2a9e4b0c1d2e3f4a5b6a'])('rejects %s', (v) =>
    expect(ObjectIdSchema.safeParse(v).success).toBe(false),
  );
});

describe('PaginationQuerySchema', () => {
  it('applies defaults', () =>
    expect(PaginationQuerySchema.parse({})).toEqual({ page: 1, limit: 20 }));
  it('coerces strings', () =>
    expect(PaginationQuerySchema.parse({ page: '3', limit: '50' })).toEqual({
      page: 3,
      limit: 50,
    }));
  it.each([{ limit: '101' }, { limit: '0' }, { page: '0' }, { page: '1.5' }])('rejects %o', (q) =>
    expect(PaginationQuerySchema.safeParse(q).success).toBe(false),
  );
});

describe('CursorQuerySchema', () => {
  it('defaults limit to 50', () => expect(CursorQuerySchema.parse({})).toEqual({ limit: 50 }));
  it('accepts a base64url cursor', () =>
    expect(CursorQuerySchema.parse({ cursor: 'eyJ0IjoxfQ', limit: '10' }).cursor).toBe(
      'eyJ0IjoxfQ',
    ));
  it('rejects a non-base64url cursor', () =>
    expect(CursorQuerySchema.safeParse({ cursor: 'a b+/' }).success).toBe(false));
});

describe('sortSchema', () => {
  const schema = sortSchema(['createdAt', 'name'] as const);

  it('defaults to -createdAt', () =>
    expect(schema.parse(undefined)).toEqual([{ field: 'createdAt', direction: 'desc' }]));
  it('parses multiple fields', () =>
    expect(schema.parse('-createdAt,name')).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: 'name', direction: 'asc' },
    ]));
  it('rejects fields outside the allowlist', () =>
    expect(schema.safeParse('password').success).toBe(false));
  it('rejects duplicates', () => expect(schema.safeParse('name,-name').success).toBe(false));
});

describe('PhoneE164Schema', () => {
  it.each(['98765 43210', '+91 98765-43210', '09876543210', '+919876543210'])(
    'normalises %s',
    (v) => expect(PhoneE164Schema.parse(v)).toBe('+919876543210'),
  );
  it('keeps foreign numbers', () =>
    expect(PhoneE164Schema.parse('+1 415 555 2671')).toBe('+14155552671'));
  it.each(['12345', 'abc', ''])('rejects %s', (v) => {
    const result = PhoneE164Schema.safeParse(v);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Invalid phone number');
  });
});

describe('MoneyMicrosSchema', () => {
  it('accepts integers ≥ 0', () =>
    expect(MoneyMicrosSchema.parse(5_500_000_000)).toBe(5_500_000_000));
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2])('rejects %s', (v) =>
    expect(MoneyMicrosSchema.safeParse(v).success).toBe(false),
  );
});

describe('strictQuery', () => {
  it('rejects unknown keys', () => {
    const schema = strictQuery({ q: z.string().optional() });
    expect(schema.safeParse({ q: 'x' }).success).toBe(true);
    expect(schema.safeParse({ q: 'x', extra: '1' }).success).toBe(false);
  });
});

describe('zodIssuesToDetails', () => {
  it('joins paths with dots and prefixes the part', () => {
    const result = z
      .object({ variables: z.object({ amount: z.number() }) })
      .safeParse({ variables: { amount: 'x' } });
    expect(result.success).toBe(false);
    expect(zodIssuesToDetails(result.error?.issues ?? [], 'body')[0]?.path).toBe(
      'body.variables.amount',
    );
  });
});
