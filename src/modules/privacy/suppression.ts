import { createHmac } from 'node:crypto';

import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { SuppressionModel, type SuppressionReason } from '../../db/models/suppression.model';
import { ProviderError } from '../../shared/errors/app-error';

const DEV_KEY = 'cav-dev-suppression-key';

/** The key, or `null` in production when it isn't set: lookups then find nothing. */
const hmacKey = (): Buffer | string | null => {
  const env = getEnv();
  if (env.SUPPRESSION_HMAC_KEY) return Buffer.from(env.SUPPRESSION_HMAC_KEY, 'base64');
  return env.NODE_ENV === 'production' ? null : DEV_KEY;
};

const hmacWith = (key: Buffer | string, phoneE164: string): string =>
  createHmac('sha256', key).update(phoneE164).digest('hex');

/** Erase routes call this first: without the key a number could come back after erasure. */
export const assertSuppressionReady = (): void => {
  if (hmacKey() === null) throw new ProviderError('PROVIDER_UNAVAILABLE');
};

/** Remembers a number without storing it. A stronger reason already there stays. */
export const recordSuppression = async (
  accountId: Types.ObjectId,
  phoneE164: string,
  reason: SuppressionReason,
  at: Date = new Date(),
): Promise<void> => {
  const key = hmacKey();
  if (key === null) throw new ProviderError('PROVIDER_UNAVAILABLE');
  await SuppressionModel.updateOne(
    { accountId, phoneHmac: hmacWith(key, phoneE164) },
    { $setOnInsert: { reason, at } },
    { upsert: true },
  );
};

/** Numbers of this list that are suppressed, with the reason. */
export const suppressedPhones = async (
  accountId: Types.ObjectId | string,
  phones: readonly string[],
): Promise<Map<string, SuppressionReason>> => {
  const key = hmacKey();
  const found = new Map<string, SuppressionReason>();
  if (key === null || phones.length === 0) return found;
  const byHmac = new Map(phones.map((p) => [hmacWith(key, p), p]));
  const rows = await SuppressionModel.find({ accountId, phoneHmac: { $in: [...byHmac.keys()] } })
    .select({ phoneHmac: 1, reason: 1 })
    .lean<{ phoneHmac: string; reason: SuppressionReason }[]>();
  for (const row of rows) {
    const phone = byHmac.get(row.phoneHmac);
    if (phone) found.set(phone, row.reason);
  }
  return found;
};

/** An opt-out or DND outlives erasure: business-initiated calls and sends stay blocked. */
export const isBlockedForOutreach = async (
  accountId: Types.ObjectId | string,
  phones: readonly string[],
): Promise<boolean> => {
  const found = await suppressedPhones(accountId, phones);
  return [...found.values()].some((reason) => reason !== 'erased');
};
