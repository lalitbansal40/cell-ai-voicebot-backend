import { randomBytes } from 'node:crypto';

import type { Request, RequestHandler } from 'express';
import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { APP_NAME } from '../../core/email/templates/layout';
import { UserModel, type UserDoc, type UserMfa } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { open, seal, secretKeys } from '../../shared/crypto/secret-box';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/app-error';
import { recordAudit } from '../audit/audit.service';

import { hmacToken } from './hmac';
import { verifyPassword } from './password';
import { matchTotp, newTotpSecret, otpauthUrl } from './totp';

/** A big superadmin action needs a code entered this recently. */
export const MFA_FRESH_MS = 15 * 60 * 1000;
const RECOVERY_CODES = 10;

const keys = () => secretKeys(getEnv());

const loadUser = async (req: Request): Promise<UserDoc> => {
  const auth = requireAuth(req);
  if (auth.platformRole !== 'superadmin' || auth.impersonatorId) throw new ForbiddenError();
  const user = await UserModel.findById(auth.userId).select('+passwordHash +mfa').lean<UserDoc>();
  if (!user) throw new NotFoundError();
  return user;
};

const audit = (
  user: UserDoc,
  req: Request,
  action: 'mfa.enabled' | 'mfa.disabled' | 'mfa.recovery_used',
) =>
  recordAudit({
    accountId: user.accountId,
    actor: { type: 'user', id: user._id, platform: true },
    action,
    target: { type: 'user', id: user._id.toString() },
    ip: req.ip ?? null,
  });

const newRecoveryCode = () => {
  const raw = randomBytes(5).toString('hex');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
};

export const mfaStatus = async (req: Request) => {
  const user = await loadUser(req);
  return { enabled: Boolean(user.mfa?.enabledAt), enforced: getEnv().MFA_ENFORCED_FOR_ADMINS };
};

/** Starts setup. Nothing is enforced until a code from the app confirms it. */
export const setupMfa = async (req: Request) => {
  const user = await loadUser(req);
  if (user.mfa?.enabledAt) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Two-step sign-in is already on.');
  }
  const secret = newTotpSecret();
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        mfa: {
          secretSealed: seal(keys(), secret),
          enabledAt: null,
          lastStep: null,
          verifiedAt: null,
          recoveryHashes: [],
        } satisfies UserMfa,
      },
    },
  );
  return { secret, otpauthUrl: otpauthUrl(secret, user.email, APP_NAME) };
};

const checkCode = (mfa: UserMfa, code: string, now: Date) =>
  matchTotp(open(keys(), mfa.secretSealed), code, now, mfa.lastStep);

/** The first good code turns it on; the recovery codes are shown once, here. */
export const confirmMfa = async (req: Request, code: string, now = new Date()) => {
  const user = await loadUser(req);
  if (!user.mfa || user.mfa.enabledAt) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Start the setup first.');
  }
  const step = checkCode(user.mfa, code, now);
  if (step === null) throw new AppError('MFA_INVALID');
  const codes = Array.from({ length: RECOVERY_CODES }, newRecoveryCode);
  await UserModel.updateOne(
    { _id: user._id },
    {
      $set: {
        'mfa.enabledAt': now,
        'mfa.lastStep': step,
        'mfa.verifiedAt': now,
        'mfa.recoveryHashes': codes.map(hmacToken),
      },
    },
  );
  await audit(user, req, 'mfa.enabled');
  return { recoveryCodes: codes };
};

/** A code from the app, or a recovery code once. Good for `MFA_FRESH_MS`. */
export const verifyMfa = async (req: Request, code: string, now = new Date()) => {
  const user = await loadUser(req);
  const mfa = user.mfa;
  if (!mfa?.enabledAt)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Two-step sign-in is off.');
  const step = checkCode(mfa, code, now);
  if (step !== null) {
    // the update only matches while this step is new, so two requests can't both use one code
    const used = await UserModel.updateOne(
      {
        _id: user._id,
        $or: [{ 'mfa.lastStep': null }, { 'mfa.lastStep': { $lt: step } }],
      },
      { $set: { 'mfa.lastStep': step, 'mfa.verifiedAt': now } },
    );
    if (used.modifiedCount === 0) throw new AppError('MFA_INVALID');
    return { verified: true as const };
  }
  const hash = hmacToken(code.trim().toLowerCase());
  const spent = await UserModel.updateOne(
    { _id: user._id, 'mfa.recoveryHashes': hash },
    { $pull: { 'mfa.recoveryHashes': hash }, $set: { 'mfa.verifiedAt': now } },
  );
  if (spent.modifiedCount === 0) throw new AppError('MFA_INVALID');
  await audit(user, req, 'mfa.recovery_used');
  return { verified: true as const };
};

/** Needs the password and a current code or recovery code. */
export const disableMfa = async (req: Request, password: string, code: string) => {
  const user = await loadUser(req);
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, password)).ok) {
    throw new AppError('REAUTH_FAILED');
  }
  await verifyMfa(req, code);
  await UserModel.updateOne({ _id: user._id }, { $set: { mfa: null } });
  await audit(user, req, 'mfa.disabled');
  return { disabled: true as const };
};

/**
 * Guards a big superadmin action when `MFA_ENFORCED_FOR_ADMINS` is on. A superadmin who hasn't
 * set it up yet passes, so turning the setting on can't lock out the only superadmin.
 */
export const requireFreshMfa =
  (enforced: boolean): RequestHandler =>
  async (req, _res, next) => {
    if (!enforced) {
      next();
      return;
    }
    const auth = requireAuth(req);
    const user = await UserModel.findById(new Types.ObjectId(auth.userId))
      .select('+mfa')
      .lean<Pick<UserDoc, 'mfa'>>();
    if (user?.mfa?.enabledAt) {
      const at = user.mfa.verifiedAt?.getTime() ?? 0;
      if (Date.now() - at > MFA_FRESH_MS) throw new AppError('MFA_REQUIRED');
    }
    next();
  };
