/**
 * Per-account retention (Phase 14, PHASE_14_PLAN §1h). Each account may keep recordings,
 * call records and WhatsApp chats for fewer days than the platform (env) default; a
 * superadmin may cap an account lower still. `null` everywhere = today's platform
 * behaviour. Recordings never outlive their call. Rollups are never touched.
 */
import type { Request } from 'express';
import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { RETENTION_LIMITS } from '../../config/limits';
import {
  AccountModel,
  type AccountDoc,
  type AccountRetention,
  type AccountRetentionCap,
} from '../../db/models/account.model';
import { tenantFilter } from '../../shared/auth/tenant';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';

export interface PlatformRetention {
  callsDays: number;
  /** `null` = chats are kept forever (`INBOX_RETENTION_DAYS=0`). */
  inboxDays: number | null;
}

export interface EffectiveRetention {
  recordingsDays: number;
  callsDays: number;
  /** `null` = kept forever. */
  inboxDays: number | null;
}

const EMPTY: AccountRetention = { recordingsDays: null, callsDays: null, inboxDays: null };
const NO_CAP: AccountRetentionCap = { callsDays: null, inboxDays: null };

export const platformRetention = (): PlatformRetention => {
  const env = getEnv();
  return {
    callsDays: env.CALL_RETENTION_DAYS,
    inboxDays: env.INBOX_RETENTION_DAYS > 0 ? env.INBOX_RETENTION_DAYS : null,
  };
};

const minOf = (a: number | null, b: number | null): number | null =>
  a === null ? b : b === null ? a : Math.min(a, b);

/** The most an account may keep: the platform default, lowered by the superadmin cap. */
export const retentionMax = (
  cap: AccountRetentionCap | null | undefined,
  platform: PlatformRetention = platformRetention(),
) => ({
  callsDays: minOf(platform.callsDays, cap?.callsDays ?? null) ?? platform.callsDays,
  inboxDays: minOf(platform.inboxDays, cap?.inboxDays ?? null),
});

/** What the purge jobs use for one account (settings clamped to the current maximum). */
export const effectiveRetention = (
  account: Pick<AccountDoc, 'retention' | 'retentionCap'>,
  platform: PlatformRetention = platformRetention(),
): EffectiveRetention => {
  const max = retentionMax(account.retentionCap, platform);
  const set = account.retention ?? EMPTY;
  const callsDays = Math.min(set.callsDays ?? max.callsDays, max.callsDays);
  return {
    callsDays,
    recordingsDays: Math.min(set.recordingsDays ?? callsDays, callsDays),
    inboxDays: minOf(set.inboxDays, max.inboxDays),
  };
};

const viewOf = (account: Pick<AccountDoc, 'retention' | 'retentionCap'>) => {
  const platform = platformRetention();
  const max = retentionMax(account.retentionCap, platform);
  return {
    settings: { ...EMPTY, ...(account.retention ?? {}) },
    effective: effectiveRetention(account, platform),
    platform,
    cap: { ...NO_CAP, ...(account.retentionCap ?? {}) },
    bounds: {
      recordingsDays: { min: RETENTION_LIMITS.recordingsMinDays, max: max.callsDays },
      callsDays: { min: RETENTION_LIMITS.callsMinDays, max: max.callsDays },
      inboxDays: {
        min: RETENTION_LIMITS.inboxMinDays,
        max: max.inboxDays ?? RETENTION_LIMITS.maxDays,
      },
    },
  };
};
export type RetentionView = ReturnType<typeof viewOf>;

const outOfBounds = (message: string) => new AppError('RETENTION_OUT_OF_BOUNDS', message);

const loadAccount = async (accountId: Types.ObjectId) => {
  const account = await AccountModel.findById(accountId)
    .select({ retention: 1, retentionCap: 1 })
    .lean<Pick<AccountDoc, '_id' | 'retention' | 'retentionCap'>>();
  if (!account) throw new NotFoundError();
  return account;
};

/** `GET /account/retention` (account.read). */
export const getRetention = async (req: Request): Promise<RetentionView> =>
  viewOf(await loadAccount(tenantFilter(req).accountId));

/** Checks one account's settings against its bounds; throws `RETENTION_OUT_OF_BOUNDS`. */
export const assertRetention = (
  next: AccountRetention,
  cap: AccountRetentionCap | null | undefined,
): void => {
  const max = retentionMax(cap);
  const inboxMax = max.inboxDays ?? RETENTION_LIMITS.maxDays;
  const { recordingsDays, callsDays, inboxDays } = next;
  if (
    callsDays !== null &&
    (callsDays < RETENTION_LIMITS.callsMinDays || callsDays > max.callsDays)
  )
    throw outOfBounds(
      `Keep call records between ${String(RETENTION_LIMITS.callsMinDays)} and ${String(max.callsDays)} days.`,
    );
  const callsLimit = callsDays ?? max.callsDays;
  if (
    recordingsDays !== null &&
    (recordingsDays < RETENTION_LIMITS.recordingsMinDays || recordingsDays > callsLimit)
  )
    throw outOfBounds(
      `Keep recordings between ${String(RETENTION_LIMITS.recordingsMinDays)} and ${String(callsLimit)} days (not longer than the calls).`,
    );
  if (inboxDays !== null && (inboxDays < RETENTION_LIMITS.inboxMinDays || inboxDays > inboxMax))
    throw outOfBounds(
      `Keep WhatsApp chats between ${String(RETENTION_LIMITS.inboxMinDays)} and ${String(inboxMax)} days.`,
    );
};

/** `PUT /account/retention` (account.update): each field a number of days or `null` (default). */
export const updateRetention = async (
  req: Request,
  body: Partial<AccountRetention>,
): Promise<RetentionView> => {
  const { accountId } = tenantFilter(req);
  const account = await loadAccount(accountId);
  const before = { ...EMPTY, ...(account.retention ?? {}) };
  const next: AccountRetention = { ...before, ...body };
  assertRetention(next, account.retentionCap);
  await AccountModel.updateOne({ _id: accountId }, { $set: { retention: next } });
  await auditRequest(req, 'account.retention_updated', {
    target: { type: 'account', id: accountId.toString() },
    meta: { from: before, to: next },
  });
  return viewOf({ retention: next, retentionCap: account.retentionCap ?? null });
};

/** Superadmin cap bounds: the platform default is the most, the account minimums the least. */
export const assertRetentionCap = (cap: AccountRetentionCap): void => {
  const platform = platformRetention();
  if (
    cap.callsDays !== null &&
    (cap.callsDays < RETENTION_LIMITS.callsMinDays || cap.callsDays > platform.callsDays)
  )
    throw outOfBounds(
      `Cap call records between ${String(RETENTION_LIMITS.callsMinDays)} and ${String(platform.callsDays)} days.`,
    );
  const inboxMax = platform.inboxDays ?? RETENTION_LIMITS.maxDays;
  if (
    cap.inboxDays !== null &&
    (cap.inboxDays < RETENTION_LIMITS.inboxMinDays || cap.inboxDays > inboxMax)
  )
    throw outOfBounds(
      `Cap WhatsApp chats between ${String(RETENTION_LIMITS.inboxMinDays)} and ${String(inboxMax)} days.`,
    );
};

export { viewOf as retentionViewOf };
