import type { CountryCode } from 'libphonenumber-js';
import { Types } from 'mongoose';

import type { FieldType } from '../../../db/models/custom-field.model';
import type { ErrorDetail } from '../../../shared/errors/app-error';
import { ValidationError } from '../../../shared/errors/app-error';
import { escapeRegex } from '../../../shared/utils/regex';
import { normalizePhone, phoneDigits } from '../normalize/phone';
import { normalizeTag } from '../normalize/tags';
import { cleanDecimal, parseDate, toMicros } from '../normalize/values';

import {
  OPERATORS_BY_TYPE,
  type ContactFilter,
  type FilterCondition,
  type FilterOperator,
} from './filter.schema';

export interface CompileContext {
  /** Field definitions by key (type decides operators and value parsing). */
  fields: ReadonlyMap<string, { type: FieldType }>;
  /** "Today" for relative date operators is evaluated in this timezone. */
  timezone: string;
  country: CountryCode;
  now?: Date;
}

export interface CompiledFilter {
  query: Record<string, unknown>;
  /** Conditions that can't be evaluated (field deleted, bad value) — they match nothing. */
  problems: ErrorDetail[];
}

const MATCH_NOTHING = { _id: { $in: [] as Types.ObjectId[] } };
const MAX_DAYS = 3650;

/** `YYYY-MM-DD` of `now` in `timezone`, shifted by `days`. */
export const isoDay = (now: Date, timezone: string, days = 0): string => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  if (days === 0) return today;
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

type Parsed = { ok: true; value: string | number } | { ok: false; message: string };

const parseOperand = (
  type: FieldType,
  raw: string | number | undefined,
  country: CountryCode,
): Parsed => {
  if (raw === undefined || raw === '') return { ok: false, message: 'A value is required' };
  switch (type) {
    case 'text':
      return { ok: true, value: String(raw) };
    case 'number': {
      const decimal = cleanDecimal(raw);
      return decimal === undefined
        ? { ok: false, message: 'Must be a number' }
        : { ok: true, value: Number(decimal) };
    }
    case 'currency': {
      const decimal = cleanDecimal(raw);
      const micros = decimal === undefined ? undefined : toMicros(decimal);
      return micros === undefined
        ? { ok: false, message: 'Must be an amount in rupees (max 2 decimals)' }
        : { ok: true, value: micros };
    }
    case 'date': {
      const iso = parseDate(raw, 'DMY');
      return iso === undefined
        ? { ok: false, message: 'Must be a date (YYYY-MM-DD)' }
        : { ok: true, value: iso };
    }
    case 'phone': {
      const phone = normalizePhone(raw, country);
      return phone.ok ? { ok: true, value: phone.e164 } : { ok: false, message: 'Invalid phone' };
    }
  }
};

const parseDays = (raw: unknown): Parsed => {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= MAX_DAYS
    ? { ok: true, value: n }
    : { ok: false, message: `Must be a whole number of days (0–${MAX_DAYS})` };
};

/** One condition → Mongo clause, or a problem message. */
const compileCondition = (
  cond: FilterCondition,
  ctx: CompileContext,
):
  | { clause: Record<string, unknown> }
  | { problem: { field: 'key' | 'op' | 'value' | 'value2'; message: string } } => {
  const field = ctx.fields.get(cond.key);
  if (!field) return { problem: { field: 'key', message: `Unknown field "${cond.key}"` } };
  const allowed = OPERATORS_BY_TYPE[field.type] as readonly FilterOperator[];
  if (!allowed.includes(cond.op)) {
    return {
      problem: { field: 'op', message: `"${cond.op}" can't be used with a ${field.type} field` },
    };
  }
  const path = `variables.${cond.key}`;
  if (cond.op === 'exists') return { clause: { [path]: { $exists: true } } };
  if (cond.op === 'not_exists') return { clause: { [path]: { $exists: false } } };

  const now = ctx.now ?? new Date();
  if (cond.op === 'within_next_days' || cond.op === 'overdue_by_days') {
    const days = parseDays(cond.value);
    if (!days.ok) return { problem: { field: 'value', message: days.message } };
    const n = days.value as number;
    return cond.op === 'within_next_days'
      ? {
          clause: {
            [path]: { $gte: isoDay(now, ctx.timezone), $lte: isoDay(now, ctx.timezone, n) },
          },
        }
      : { clause: { [path]: { $lte: isoDay(now, ctx.timezone, -n) } } };
  }

  const value = parseOperand(field.type, cond.value, ctx.country);
  if (!value.ok) return { problem: { field: 'value', message: value.message } };
  const v = value.value;
  switch (cond.op) {
    case 'eq':
    case 'on':
      return { clause: { [path]: v } };
    case 'neq':
      return { clause: { [path]: { $ne: v } } };
    case 'contains':
      return { clause: { [path]: { $regex: escapeRegex(String(v)), $options: 'i' } } };
    case 'gt':
    case 'after':
      return { clause: { [path]: { $gt: v } } };
    case 'gte':
      return { clause: { [path]: { $gte: v } } };
    case 'lt':
    case 'before':
      return { clause: { [path]: { $lt: v } } };
    case 'lte':
      return { clause: { [path]: { $lte: v } } };
    case 'between': {
      const upper = parseOperand(field.type, cond.value2, ctx.country);
      if (!upper.ok) return { problem: { field: 'value2', message: upper.message } };
      return { clause: { [path]: { $gte: v, $lte: upper.value } } };
    }
  }
  /* c8 ignore next */
  return { problem: { field: 'op', message: 'Unsupported operator' } };
};

/**
 * Contact filter → Mongo query, always scoped to the account and live
 * contacts (PHASE_3_PLAN §1d). Pure: no I/O. Bad conditions become
 * `problems` and make the whole filter match nothing.
 */
export const compileContactFilter = (
  accountId: Types.ObjectId,
  filter: ContactFilter,
  ctx: CompileContext,
): CompiledFilter => {
  const and: Record<string, unknown>[] = [];
  const problems: ErrorDetail[] = [];

  if (filter.listIds?.length) {
    and.push({ listIds: { $in: filter.listIds.map((id) => new Types.ObjectId(id)) } });
  }
  if (filter.tags) {
    const values = filter.tags.values
      .map((t) => normalizeTag(t))
      .filter((t): t is string => Boolean(t));
    if (values.length !== filter.tags.values.length) {
      problems.push({ path: 'tags.values', message: 'Invalid tag' });
    } else {
      and.push({ tags: filter.tags.mode === 'all' ? { $all: values } : { $in: values } });
    }
  }
  if (filter.dnd !== undefined) and.push({ dnd: filter.dnd });
  if (filter.optedOut !== undefined) {
    and.push({ optedOutAt: filter.optedOut ? { $ne: null } : null });
  }
  if (filter.createdFrom || filter.createdTo) {
    and.push({
      createdAt: {
        ...(filter.createdFrom ? { $gte: new Date(filter.createdFrom) } : {}),
        ...(filter.createdTo ? { $lt: new Date(filter.createdTo) } : {}),
      },
    });
  }
  if (filter.q) {
    const text = escapeRegex(filter.q.toLowerCase().replace(/\s+/g, ' '));
    // Trunk / international prefixes (`0`, `00`) are not part of the stored E.164 digits.
    const digits = phoneDigits(filter.q).replace(/^0+/, '');
    const phoneLike = /^[\d\s+\-().]+$/.test(filter.q) && digits.length >= 3;
    and.push(
      phoneLike
        ? { $or: [{ searchText: { $regex: text } }, { searchText: { $regex: digits } }] }
        : { searchText: { $regex: text } },
    );
  }
  filter.conditions?.forEach((cond, i) => {
    const result = compileCondition(cond, ctx);
    if ('clause' in result) and.push(result.clause);
    else
      problems.push({
        path: `conditions.${i}.${result.problem.field}`,
        message: result.problem.message,
      });
  });

  const base = { accountId, deletedAt: null };
  if (problems.length) return { query: { ...base, ...MATCH_NOTHING }, problems };
  return { query: and.length ? { ...base, $and: and } : base, problems };
};

/** Strict variant for request bodies: problems → 422 with paths prefixed by `prefix`. */
export const compileOrThrow = (
  accountId: Types.ObjectId,
  filter: ContactFilter,
  ctx: CompileContext,
  prefix = 'filter',
): Record<string, unknown> => {
  const { query, problems } = compileContactFilter(accountId, filter, ctx);
  if (problems.length) {
    throw new ValidationError(
      problems.map((p) => ({ ...p, path: prefix ? `${prefix}.${p.path}` : p.path })),
    );
  }
  return query;
};
