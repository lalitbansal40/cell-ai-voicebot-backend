import { stringify } from 'csv-stringify';
import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { BILLING_LIMITS } from '../../config/limits';
import { LedgerEntryModel, type LedgerEntryDoc } from '../../db/models/ledger-entry.model';
import { UserModel } from '../../db/models/user.model';
import { tenantFilter } from '../../shared/auth/tenant';
import { NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor';
import { toDecimalString } from '../../shared/money';
import { addDays, formatDateTimeInZone, startOfDayInZone } from '../../shared/time';
import { safeCell } from '../contact-imports/error-report';

import type { LedgerExportQuery, LedgerQuery } from './wallet.schema';
import { accountTimezone } from './wallet.service';

const TYPE_TEXT: Record<LedgerEntryDoc['type'], string> = {
  topup: 'Wallet recharge',
  call_charge: 'Call charge',
  ai_charge: 'AI usage',
  tts_charge: 'Voice (TTS) usage',
  adjustment: 'Adjustment',
  refund: 'Refund',
  subscription: 'Subscription',
  recording_charge: 'Recording storage',
};

/** Human description of a row (built here, never stored). */
export const describeEntry = (e: Pick<LedgerEntryDoc, 'type' | 'status' | 'note'>): string => {
  if (e.type === 'call_charge' && e.status !== 'captured') return 'Call hold';
  if (e.type === 'adjustment' && e.note) return `Adjustment: ${e.note}`;
  return TYPE_TEXT[e.type];
};

export const toLedgerView = (e: LedgerEntryDoc, names: Map<string, string>) => ({
  id: e._id.toString(),
  type: e.type,
  direction: e.direction,
  status: e.status,
  amountMicros: e.amountMicros,
  currency: 'INR' as const,
  balanceAfterMicros: e.balanceAfterMicros ?? null,
  breakdown: e.breakdown ?? null,
  ref: { type: e.ref.type, id: e.ref.id },
  holdId: e.holdId ? e.holdId.toString() : null,
  description: describeEntry(e),
  note: e.note ?? null,
  createdBy: e.createdBy
    ? { id: e.createdBy.toString(), name: names.get(e.createdBy.toString()) ?? null }
    : null,
  releasedAt: e.releasedAt ? e.releasedAt.toISOString() : null,
  releaseReason: e.releaseReason ?? null,
  createdAt: e.createdAt.toISOString(),
});

export const userNames = async (rows: Pick<LedgerEntryDoc, 'createdBy'>[]) => {
  const ids = [...new Set(rows.filter((r) => r.createdBy).map((r) => String(r.createdBy)))];
  if (!ids.length) return new Map<string, string>();
  const users = await UserModel.find({ _id: { $in: ids } })
    .setOptions({ withDeleted: true })
    .select({ name: 1 })
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  return new Map(users.map((u) => [u._id.toString(), u.name]));
};

/** Newest first, keyset cursor `{ at: createdAt, id }`. */
export const listLedger = async (accountId: Types.ObjectId, query: z.infer<typeof LedgerQuery>) => {
  const filter: Record<string, unknown> = { accountId };
  if (query.type) filter.type = { $in: query.type };
  if (query.status) filter.status = query.status;
  if (query.refType) filter['ref.type'] = query.refType;
  const at: Record<string, Date> = {};
  if (query.from) at.$gte = new Date(query.from);
  if (query.to) at.$lt = new Date(query.to);
  if (Object.keys(at).length) filter.createdAt = at;
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    const cAt = new Date(c.at);
    filter.$or = [
      { createdAt: { $lt: cAt } },
      { createdAt: cAt, _id: { $lt: new Types.ObjectId(c.id) } },
    ];
  }
  const rows = await LedgerEntryModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean<LedgerEntryDoc[]>();
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const names = await userNames(page);
  const last = page.at(-1);
  return {
    items: page.map((r) => toLedgerView(r, names)),
    meta: {
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last._id.toString() })
          : null,
    },
  };
};

export const getLedgerEntry = async (accountId: Types.ObjectId, id: string) => {
  const row = await LedgerEntryModel.findOne({ _id: id, accountId }).lean<LedgerEntryDoc>();
  if (!row) throw new NotFoundError('Ledger entry not found');
  return toLedgerView(row, await userNames([row]));
};

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const HEADER = [
  'date',
  'description',
  'type',
  'direction',
  'status',
  'amount_inr',
  'balance_after_inr',
  'ref_type',
  'ref_id',
  'note',
];

/** CSV of a date range (account timezone), streamed; BOM, injection-safe text. */
export const exportLedger = async (
  req: Request,
  res: Response,
  query: z.infer<typeof LedgerExportQuery>,
  { maxRows = BILLING_LIMITS.ledgerExportMaxRows }: { maxRows?: number } = {},
): Promise<void> => {
  const { accountId } = tenantFilter(req);
  if (daysBetween(query.from, query.to) > BILLING_LIMITS.ledgerExportMaxDays) {
    throw new ValidationError([
      { path: 'query.to', message: `At most ${BILLING_LIMITS.ledgerExportMaxDays} days` },
    ]);
  }
  const tz = await accountTimezone(accountId);
  const filter = {
    accountId,
    createdAt: {
      $gte: startOfDayInZone(query.from, tz),
      $lt: startOfDayInZone(addDays(query.to, 1), tz),
    },
  };
  if ((await LedgerEntryModel.countDocuments(filter)) > maxRows) {
    throw new ValidationError([
      { path: 'query.to', message: 'Too many rows — narrow the date range' },
    ]);
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ledger-${query.from}-${query.to}.csv"`,
  );
  res.write('﻿');
  const csv = stringify({ header: true, columns: HEADER, record_delimiter: '\r\n' });
  csv.pipe(res);
  const cursor = LedgerEntryModel.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .lean<LedgerEntryDoc[]>()
    .cursor();
  for await (const raw of cursor) {
    const e = raw;
    const signed = e.direction === 'debit' ? -e.amountMicros : e.amountMicros;
    csv.write([
      formatDateTimeInZone(e.createdAt, tz),
      safeCell(describeEntry(e)),
      e.type,
      e.direction,
      e.status,
      toDecimalString(signed),
      e.balanceAfterMicros === null || e.balanceAfterMicros === undefined
        ? ''
        : toDecimalString(e.balanceAfterMicros),
      e.ref.type,
      safeCell(e.ref.id),
      safeCell(e.note ?? ''),
    ]);
  }
  csv.end();
  await new Promise<void>((resolve) => res.on('finish', resolve));
};
