import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import {
  RefreshTokenModel,
  type RefreshTokenDoc,
  type RevokeReason,
} from '../../db/models/refresh-token.model';
import { withTransaction } from '../../db/transaction';
import { UnauthenticatedError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import { hmacToken, randomToken } from './hmac';

export interface SessionMeta {
  userAgent?: string | null;
  ip?: string | null;
}

const DURATION_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `30d` → milliseconds (JWT_*_TTL format, validated by env). */
export const durationMs = (value: string): number => {
  const unit = value.slice(-1);
  return Number(value.slice(0, -1)) * (DURATION_MS[unit] ?? 0);
};

export const refreshTtlMs = (): number => durationMs(getEnv().JWT_REFRESH_TTL);

type ReuseHook = (doc: RefreshTokenDoc) => void | Promise<void>;
let onReuseDetected: ReuseHook = (doc) => {
  getLogger().warn(
    { userId: doc.userId.toString(), familyId: doc.familyId },
    'auth: refresh token reuse detected',
  );
};

/** Lets the audit module record `auth.refresh_reuse_detected` without a circular import. */
export const setReuseDetectedHook = (hook: ReuseHook): void => {
  onReuseDetected = hook;
};

/** Creates a refresh token (new family = new login session). Returns the raw token once. */
export const issueRefresh = async (input: {
  userId: Types.ObjectId;
  accountId: Types.ObjectId;
  familyId?: string;
  meta?: SessionMeta;
}): Promise<{ raw: string; doc: RefreshTokenDoc }> => {
  const raw = randomToken();
  const [doc] = await RefreshTokenModel.create([
    {
      userId: input.userId,
      accountId: input.accountId,
      familyId: input.familyId ?? randomToken(12),
      tokenHash: hmacToken(raw),
      expiresAt: new Date(Date.now() + refreshTtlMs()),
      userAgent: input.meta?.userAgent?.slice(0, 300) ?? null,
      ip: input.meta?.ip ?? null,
      lastUsedAt: new Date(),
    },
  ]);
  if (!doc) throw new Error('refresh token not created');
  return { raw, doc: doc.toObject({ transform: false }) };
};

export const revokeFamily = async (familyId: string, reason: RevokeReason): Promise<number> => {
  const res = await RefreshTokenModel.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
};

export const revokeAllForUser = async (
  userId: Types.ObjectId | string,
  reason: RevokeReason,
  options: { exceptFamilyId?: string } = {},
): Promise<number> => {
  const res = await RefreshTokenModel.updateMany(
    {
      userId,
      revokedAt: null,
      ...(options.exceptFamilyId ? { familyId: { $ne: options.exceptFamilyId } } : {}),
    },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return res.modifiedCount;
};

/**
 * Rotates a refresh token: the presented one is revoked (`rotated`) and a new
 * one in the same family is returned. A token that was already rotated or
 * revoked means it leaked → the whole family is revoked (AUTH_SESSION_REVOKED).
 * The conditional update makes concurrent rotations safe: exactly one wins,
 * the loser is treated as reuse.
 */
export const rotateRefresh = async (
  raw: string,
  meta: SessionMeta = {},
): Promise<{ raw: string; doc: RefreshTokenDoc; previous: RefreshTokenDoc }> => {
  const tokenHash = hmacToken(raw);
  const existing = await RefreshTokenModel.findOne({ tokenHash }).lean();
  if (!existing) throw new UnauthenticatedError();
  if (existing.revokedAt) {
    await revokeFamily(existing.familyId, 'reuse_detected');
    await onReuseDetected(existing);
    throw new UnauthenticatedError('AUTH_SESSION_REVOKED');
  }
  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new UnauthenticatedError('AUTH_SESSION_REVOKED');
  }

  return withTransaction(async (session) => {
    const claimed = await RefreshTokenModel.findOneAndUpdate(
      { _id: existing._id, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: 'rotated', lastUsedAt: new Date() } },
      { session, new: true },
    ).lean();
    if (!claimed) {
      // Lost a race with a concurrent rotation of the same token → reuse.
      await RefreshTokenModel.updateMany(
        { familyId: existing.familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'reuse_detected' } },
        { session },
      );
      await onReuseDetected(existing);
      throw new UnauthenticatedError('AUTH_SESSION_REVOKED');
    }
    const next = randomToken();
    const [created] = await RefreshTokenModel.create(
      [
        {
          userId: existing.userId,
          accountId: existing.accountId,
          familyId: existing.familyId,
          tokenHash: hmacToken(next),
          expiresAt: new Date(Date.now() + refreshTtlMs()),
          userAgent: meta.userAgent?.slice(0, 300) ?? existing.userAgent ?? null,
          ip: meta.ip ?? existing.ip ?? null,
          lastUsedAt: new Date(),
        },
      ],
      { session },
    );
    if (!created) throw new Error('refresh token not created');
    await RefreshTokenModel.updateOne(
      { _id: existing._id },
      { $set: { replacedBy: created._id } },
      { session },
    );
    return {
      raw: next,
      doc: created.toObject({ transform: false }),
      previous: claimed,
    };
  });
};

export interface ActiveSession {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

/** One entry per live family (the newest unrevoked token of each). */
export const listActiveSessions = async (
  userId: Types.ObjectId | string,
): Promise<ActiveSession[]> => {
  const live = await RefreshTokenModel.find({
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  })
    .sort({ createdAt: 1 })
    .lean();
  const firstSeen = await RefreshTokenModel.aggregate<{ _id: string; createdAt: Date }>([
    { $match: { familyId: { $in: live.map((t) => t.familyId) } } },
    { $group: { _id: '$familyId', createdAt: { $min: '$createdAt' } } },
  ]);
  const started = new Map(firstSeen.map((f) => [f._id, f.createdAt]));
  return live
    .map((t) => ({
      id: t.familyId,
      userAgent: t.userAgent ?? null,
      ip: t.ip ?? null,
      createdAt: started.get(t.familyId) ?? t.createdAt,
      lastUsedAt: t.lastUsedAt,
    }))
    .sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
};
