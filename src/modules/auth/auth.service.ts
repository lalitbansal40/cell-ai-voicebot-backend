import type { Request, Response } from 'express';
import type { z } from 'zod';

import { getEnv } from '../../config/env';
import { createWallet } from '../../core/billing/wallets';
import { getEmail } from '../../core/email';
import { AccountModel } from '../../db/models/account.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { withTransaction } from '../../db/transaction';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { uniqueSlug } from '../account/slug';
import { recordAudit } from '../audit/audit.service';
import { syncSystemRoles } from '../rbac/roles.service';

import { OTP_TTL_MS } from './auth.constants';
import type { SignupBody } from './auth.schema';
import { consumeOtp, issueOtp } from './codes.service';
import { hashPassword, validatePasswordPolicy } from './password';
import { startSession, type AuthSession } from './session';

const frontendUrl = (path: string) => `${getEnv().FRONTEND_URL.replace(/\/+$/, '')}${path}`;

/** Finds a live (not removed) user by e-mail. */
export const findUserByEmail = (email: string) =>
  UserModel.findOne({ email: email.trim().toLowerCase() }).lean<UserDoc>();

/** Issues + emails a verification code. Cooldown / caps are swallowed when `quiet`. */
export const sendVerificationCode = async (
  user: Pick<UserDoc, '_id' | 'name' | 'email'>,
  { quiet }: { quiet: boolean },
): Promise<void> => {
  let code: string;
  try {
    code = await issueOtp(user._id);
  } catch (err) {
    if (quiet && err instanceof AppError && err.code === 'AUTH_TOO_MANY_ATTEMPTS') return;
    throw err;
  }
  await getEmail().enqueue(
    'auth.verify_email',
    user.email,
    { name: user.name, code, minutes: OTP_TTL_MS / 60_000 },
    { dedupeKey: `verify:${user._id.toString()}:${Date.now()}` },
  );
};

/**
 * Signup (always answers 202 — no account enumeration):
 * - new email → account + 5 system roles + owner (unverified) in one transaction, then an OTP;
 * - unverified owner signing up again → a new OTP;
 * - any other existing email → "you already have an account" email.
 */
export const signup = async (body: z.infer<typeof SignupBody>): Promise<void> => {
  const email = body.email.trim().toLowerCase();
  const issues = validatePasswordPolicy(body.password, { email, name: body.name }, 'body.password');
  if (issues.length) throw new ValidationError(issues);

  const existing = await findUserByEmail(email);
  if (existing) {
    if (existing.status === 'active' && !existing.emailVerifiedAt) {
      await sendVerificationCode(existing, { quiet: true });
      return;
    }
    const hour = Math.floor(Date.now() / 3_600_000);
    await getEmail().enqueue(
      'auth.account_exists',
      email,
      {
        name: existing.name,
        loginUrl: frontendUrl('/login'),
        resetUrl: frontendUrl('/forgot-password'),
      },
      { dedupeKey: `exists:${existing._id.toString()}:${hour}` },
    );
    return;
  }

  const passwordHash = await hashPassword(body.password);
  const owner = await withTransaction(async (session) => {
    const [account] = await AccountModel.create(
      [
        {
          name: body.businessName,
          slug: await uniqueSlug(body.businessName, session),
          ...(body.timezone ? { timezone: body.timezone } : {}),
        },
      ],
      { session },
    );
    if (!account) throw new Error('account not created');
    const roles = await syncSystemRoles(account._id, session);
    await createWallet(account._id, session);
    const [user] = await UserModel.create(
      [
        {
          accountId: account._id,
          roleId: roles.owner,
          name: body.name,
          email,
          phone: body.phone ?? null,
          passwordHash,
          status: 'active',
          emailVerifiedAt: null,
        },
      ],
      { session },
    );
    if (!user) throw new Error('user not created');
    await AccountModel.updateOne(
      { _id: account._id },
      { $set: { ownerId: user._id } },
      { session },
    );
    return user;
  });

  await recordAudit({
    accountId: owner.accountId,
    actor: { type: 'user', id: owner._id },
    action: 'account.created',
    target: { type: 'account', id: owner.accountId.toString() },
  });
  await sendVerificationCode(owner, { quiet: true });
};

/** Confirms the email code, marks the email verified and signs the user in. */
export const verifyEmail = async (
  req: Request,
  res: Response,
  input: { email: string; code: string },
): Promise<AuthSession> => {
  const user = await findUserByEmail(input.email);
  if (!user || user.status !== 'active' || user.emailVerifiedAt) {
    throw new AppError('AUTH_CODE_INVALID');
  }
  await consumeOtp(user._id, input.code);
  await UserModel.updateOne(
    { _id: user._id },
    { $set: { emailVerifiedAt: new Date(), lastLoginAt: new Date() } },
  );
  await recordAudit({
    accountId: user.accountId,
    actor: { type: 'user', id: user._id },
    action: 'auth.email_verified',
    target: { type: 'user', id: user._id.toString() },
    ip: req.ip ?? null,
  });
  return startSession(req, res, user._id);
};

/** Resend (always 202): only unverified active users get a code, within the limits. */
export const resendVerification = async (email: string): Promise<void> => {
  const user = await findUserByEmail(email);
  if (!user || user.status !== 'active' || user.emailVerifiedAt) return;
  await sendVerificationCode(user, { quiet: true });
};

/** Pads a response to at least `ms` so both branches of enumeration-safe routes look the same. */
export const withMinDuration = async <T>(ms: number, work: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const left = ms - (Date.now() - started);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  }
};
