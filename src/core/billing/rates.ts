import { Types } from 'mongoose';
import { z } from 'zod';

import { BILLING_LIMITS } from '../../config/limits';
import {
  PULSE_SECONDS,
  RateCardModel,
  type RateCardDoc,
  type RateCardValues,
} from '../../db/models/rate-card.model';
import { ValidationError } from '../../shared/errors/app-error';

export interface EffectiveRateCard extends RateCardValues {
  id: string;
  source: 'account' | 'default';
  effectiveFrom: Date;
}

const rate = z.number().int().min(0).max(BILLING_LIMITS.rateMaxMicros);

/** Values a superadmin may set (PHASE_4_PLAN T4.2). */
export const RateCardValuesSchema = z.strictObject({
  callPerMinuteMicros: rate,
  pulseSeconds: z.union(
    PULSE_SECONDS.map((p) => z.literal(p)) as [
      z.ZodLiteral<15>,
      z.ZodLiteral<30>,
      z.ZodLiteral<60>,
    ],
  ),
  aiPerMinuteMicros: rate,
  ttsPer1kCharsMicros: rate,
  commissionBps: z.number().int().min(0).max(10_000),
  billUnansweredAttempts: z.boolean(),
});

const VALUE_KEYS = Object.keys(RateCardValuesSchema.shape) as (keyof RateCardValues)[];

const pickValues = (doc: RateCardValues): RateCardValues =>
  Object.fromEntries(VALUE_KEYS.map((k) => [k, doc[k]])) as unknown as RateCardValues;

const toEffective = (doc: RateCardDoc, source: 'account' | 'default'): EffectiveRateCard => ({
  ...pickValues(doc),
  id: doc._id.toString(),
  source,
  effectiveFrom: doc.effectiveFrom,
});

const latest = (accountId: Types.ObjectId | null, at: Date) =>
  RateCardModel.findOne({ accountId, effectiveFrom: { $lte: at } })
    .sort({ effectiveFrom: -1, _id: -1 })
    .lean<RateCardDoc>();

const cache = new Map<string, { card: EffectiveRateCard; at: number }>();

/** Drops cached cards — one account, or all (a default change affects everyone). */
export const invalidateRateCardCache = (accountId?: Types.ObjectId | string): void => {
  if (accountId === undefined) cache.clear();
  else cache.delete(accountId.toString());
};

/**
 * Prices that apply to an account: its latest override (unless it went back
 * to the default), else the platform default. Cached 60 s per account for
 * "now" lookups (multi-instance staleness ≤ 60 s — ADR 0032).
 */
export const effectiveRateCard = async (
  accountId: Types.ObjectId | string,
  { at }: { at?: Date } = {},
): Promise<EffectiveRateCard> => {
  const key = accountId.toString();
  const now = Date.now();
  if (!at) {
    const hit = cache.get(key);
    if (hit && now - hit.at < BILLING_LIMITS.rateCardCacheMs) return hit.card;
  }
  const when = at ?? new Date(now);
  const own = await latest(new Types.ObjectId(key), when);
  let card: EffectiveRateCard;
  if (own && !own.inheritsDefault) {
    card = toEffective(own, 'account');
  } else {
    const platform = await latest(null, when);
    if (!platform) throw new Error('No platform default rate card — run `npm run db:migrate`');
    card = toEffective(platform, 'default');
  }
  if (!at) cache.set(key, { card, at: now });
  return card;
};

/** A specific card (the one snapshotted on a hold). */
export const rateCardById = async (id: Types.ObjectId | string): Promise<RateCardValues> => {
  const doc = await RateCardModel.findById(id).lean<RateCardDoc>();
  if (!doc) throw new Error(`Rate card ${id.toString()} not found`);
  return pickValues(doc);
};

const parseValues = (values: unknown): RateCardValues => {
  const parsed = RateCardValuesSchema.safeParse(values);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
};

/** Inserts a new version (history is never edited). `accountId: null` = platform default. */
export const createRateCardVersion = async ({
  accountId,
  values,
  createdBy,
  note = null,
  effectiveFrom = new Date(),
}: {
  accountId: Types.ObjectId | null;
  values: unknown;
  createdBy: Types.ObjectId | null;
  note?: string | null;
  effectiveFrom?: Date;
}): Promise<RateCardDoc> => {
  const doc = await RateCardModel.create({
    accountId,
    ...parseValues(values),
    inheritsDefault: false,
    effectiveFrom,
    createdBy,
    note,
  });
  invalidateRateCardCache(accountId ?? undefined);
  return doc.toObject({ transform: false });
};

/** Ends an account override: the platform default applies again (history kept). */
export const setAccountToDefault = async ({
  accountId,
  createdBy,
  note = null,
}: {
  accountId: Types.ObjectId;
  createdBy: Types.ObjectId | null;
  note?: string | null;
}): Promise<RateCardDoc> => {
  const platform = await latest(null, new Date());
  if (!platform) throw new Error('No platform default rate card — run `npm run db:migrate`');
  const doc = await RateCardModel.create({
    accountId,
    ...pickValues(platform),
    inheritsDefault: true,
    effectiveFrom: new Date(),
    createdBy,
    note,
  });
  invalidateRateCardCache(accountId);
  return doc.toObject({ transform: false });
};

/** Newest first. `accountId: null` = platform default history. */
export const rateCardHistory = (accountId: Types.ObjectId | null, limit = 50) =>
  RateCardModel.find({ accountId })
    .sort({ effectiveFrom: -1, _id: -1 })
    .limit(limit)
    .lean<RateCardDoc[]>();
