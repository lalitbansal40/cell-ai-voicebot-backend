import type { Request } from 'express';
import type { z } from 'zod';

import { BILLING_LIMITS } from '../../config/limits';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { tenantFilter } from '../../shared/auth/tenant';
import { ValidationError } from '../../shared/errors/app-error';
import { addDays, startOfDayInZone, ymdInZone } from '../../shared/time';

import type { UsageQuery } from './wallet.schema';
import { accountTimezone } from './wallet.service';

interface DayRow {
  _id: string;
  callMicros: number;
  aiMicros: number;
  ttsMicros: number;
  otherMicros: number;
}

const zero = () => ({ callMicros: 0, aiMicros: 0, ttsMicros: 0, otherMicros: 0, totalMicros: 0 });

/**
 * Daily usage from captured debits (same split as the wallet's month spend:
 * AI and TTS as billed, telephony + commission = call). Days without usage are 0.
 */
export const getUsage = async (req: Request, query: z.infer<typeof UsageQuery>) => {
  const { accountId } = tenantFilter(req);
  const tz = await accountTimezone(accountId);
  const today = ymdInZone(new Date(), tz);
  const from = query.from ?? `${today.slice(0, 7)}-01`;
  const to = query.to ?? today;
  if (from > to) {
    throw new ValidationError([{ path: 'query.to', message: 'from must not be after to' }]);
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  if (days > BILLING_LIMITS.usageMaxDays) {
    throw new ValidationError([
      { path: 'query.to', message: `At most ${BILLING_LIMITS.usageMaxDays} days` },
    ]);
  }
  const rows = await LedgerEntryModel.aggregate<DayRow>([
    {
      $match: {
        accountId,
        status: 'captured',
        direction: 'debit',
        type: { $in: ['call_charge', 'ai_charge', 'tts_charge', 'recording_charge'] },
        createdAt: {
          $gte: startOfDayInZone(from, tz),
          $lt: startOfDayInZone(addDays(to, 1), tz),
        },
      },
    },
    {
      $project: {
        day: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: tz } },
        ai: {
          $cond: [
            { $eq: ['$type', 'ai_charge'] },
            '$amountMicros',
            { $ifNull: ['$breakdown.aiMicros', 0] },
          ],
        },
        tts: {
          $cond: [
            { $eq: ['$type', 'tts_charge'] },
            '$amountMicros',
            { $ifNull: ['$breakdown.ttsMicros', 0] },
          ],
        },
        call: {
          $cond: [
            { $eq: ['$type', 'call_charge'] },
            {
              $subtract: [
                '$amountMicros',
                {
                  $add: [
                    { $ifNull: ['$breakdown.aiMicros', 0] },
                    { $ifNull: ['$breakdown.ttsMicros', 0] },
                  ],
                },
              ],
            },
            0,
          ],
        },
        other: { $cond: [{ $eq: ['$type', 'recording_charge'] }, '$amountMicros', 0] },
      },
    },
    {
      $group: {
        _id: '$day',
        callMicros: { $sum: '$call' },
        aiMicros: { $sum: '$ai' },
        ttsMicros: { $sum: '$tts' },
        otherMicros: { $sum: '$other' },
      },
    },
  ]);
  const byDay = new Map(rows.map((r) => [r._id, r]));
  const totals = zero();
  const series = Array.from({ length: days }, (_, i) => {
    const date = addDays(from, i);
    const r = byDay.get(date);
    const point = {
      date,
      callMicros: r?.callMicros ?? 0,
      aiMicros: r?.aiMicros ?? 0,
      ttsMicros: r?.ttsMicros ?? 0,
      otherMicros: r?.otherMicros ?? 0,
      totalMicros: 0,
    };
    point.totalMicros = point.callMicros + point.aiMicros + point.ttsMicros + point.otherMicros;
    totals.callMicros += point.callMicros;
    totals.aiMicros += point.aiMicros;
    totals.ttsMicros += point.ttsMicros;
    totals.otherMicros += point.otherMicros;
    totals.totalMicros += point.totalMicros;
    return point;
  });
  return { from, to, timezone: tz, series, totals };
};
