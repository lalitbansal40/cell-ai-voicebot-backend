import type { Types } from 'mongoose';

import { AuthCodeModel, type AuthCodePurpose } from '../../db/models/auth-code.model';
import { AppError, TooManyAttemptsError } from '../../shared/errors/app-error';

import {
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS_PER_HOUR,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  RESET_TTL_MS,
} from './auth.constants';
import { hmacToken, randomOtp, randomToken, safeEqualHex } from './hmac';

const HOUR_MS = 60 * 60_000;

const invalid = () => new AppError('AUTH_CODE_INVALID');

/** OTP hash binds the user + purpose, so a code can't be replayed for another user. */
const otpHash = (userId: Types.ObjectId | string, purpose: AuthCodePurpose, code: string) =>
  hmacToken(`${userId.toString()}:${purpose}:${code}`);

/**
 * Issues (or replaces) the user's email OTP. Enforces the 60 s resend
 * cooldown and the hourly send cap → AUTH_TOO_MANY_ATTEMPTS + Retry-After.
 */
export const issueOtp = async (userId: Types.ObjectId): Promise<string> => {
  const now = Date.now();
  const existing = await AuthCodeModel.findOne({ userId, purpose: 'verify_email' }).lean();
  let sentCount = 1;
  let sendWindowStart = new Date(now);
  if (existing) {
    const sinceLast = now - existing.lastSentAt.getTime();
    if (sinceLast < OTP_RESEND_COOLDOWN_MS) {
      throw new TooManyAttemptsError((OTP_RESEND_COOLDOWN_MS - sinceLast) / 1000);
    }
    const windowAge = now - existing.sendWindowStart.getTime();
    if (windowAge < HOUR_MS) {
      if (existing.sentCount >= OTP_MAX_SENDS_PER_HOUR) {
        throw new TooManyAttemptsError((HOUR_MS - windowAge) / 1000);
      }
      sentCount = existing.sentCount + 1;
      sendWindowStart = existing.sendWindowStart;
    }
  }
  const code = randomOtp();
  await AuthCodeModel.updateOne(
    { userId, purpose: 'verify_email' },
    {
      $set: {
        codeHash: otpHash(userId, 'verify_email', code),
        attempts: 0,
        sentCount,
        sendWindowStart,
        lastSentAt: new Date(now),
        expiresAt: new Date(now + OTP_TTL_MS),
        usedAt: null,
      },
    },
    { upsert: true },
  );
  return code;
};

/** Checks an OTP: wrong → attempts++ (5th wrong burns the code), expired / used → invalid. */
export const consumeOtp = async (userId: Types.ObjectId, code: string): Promise<void> => {
  const doc = await AuthCodeModel.findOne({ userId, purpose: 'verify_email' }).lean();
  if (!doc || doc.usedAt || doc.expiresAt.getTime() <= Date.now()) throw invalid();
  if (doc.attempts >= OTP_MAX_ATTEMPTS)
    throw new TooManyAttemptsError(OTP_RESEND_COOLDOWN_MS / 1000);
  if (!/^\d{6}$/.test(code) || !safeEqualHex(doc.codeHash, otpHash(userId, 'verify_email', code))) {
    const updated = await AuthCodeModel.findOneAndUpdate(
      { _id: doc._id },
      { $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if ((updated?.attempts ?? OTP_MAX_ATTEMPTS) >= OTP_MAX_ATTEMPTS) {
      throw new TooManyAttemptsError(OTP_RESEND_COOLDOWN_MS / 1000);
    }
    throw invalid();
  }
  const used = await AuthCodeModel.updateOne(
    { _id: doc._id, usedAt: null },
    { $set: { usedAt: new Date() } },
  );
  if (used.modifiedCount !== 1) throw invalid();
};

/** Password reset token (32 bytes, 30 min, single use). Returns the raw token once. */
export const issueResetToken = async (userId: Types.ObjectId): Promise<string> => {
  const raw = randomToken();
  const now = Date.now();
  await AuthCodeModel.updateOne(
    { userId, purpose: 'reset_password' },
    {
      $set: {
        codeHash: hmacToken(raw),
        attempts: 0,
        sentCount: 1,
        sendWindowStart: new Date(now),
        lastSentAt: new Date(now),
        expiresAt: new Date(now + RESET_TTL_MS),
        usedAt: null,
      },
    },
    { upsert: true },
  );
  return raw;
};

/** Checks a reset token without using it (validate the new password first). */
export const peekResetToken = async (raw: string): Promise<Types.ObjectId> => {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) throw invalid();
  const doc = await AuthCodeModel.findOne({
    codeHash: hmacToken(raw),
    purpose: 'reset_password',
    usedAt: null,
    expiresAt: { $gt: new Date() },
  }).lean();
  if (!doc) throw invalid();
  return doc.userId;
};

/** Consumes a reset token → the user id. Unknown / expired / used → AUTH_CODE_INVALID. */
export const consumeResetToken = async (raw: string): Promise<Types.ObjectId> => {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(raw)) throw invalid();
  const doc = await AuthCodeModel.findOneAndUpdate(
    {
      codeHash: hmacToken(raw),
      purpose: 'reset_password',
      usedAt: null,
      expiresAt: { $gt: new Date() },
    },
    { $set: { usedAt: new Date() } },
  ).lean();
  if (!doc) throw invalid();
  return doc.userId;
};
