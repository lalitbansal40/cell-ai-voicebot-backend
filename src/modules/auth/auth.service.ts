import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import type { z } from 'zod';

import { createWallet } from '../../core/billing/wallets';
import { AccountModel, defaultResellerInfo } from '../../db/models/account.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { withTransaction } from '../../db/transaction';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { getSignupSettings } from '../account/kinds';
import { uniqueSlug } from '../account/slug';
import { recordAudit } from '../audit/audit.service';
import { notify } from '../notifications/notifications.service';
import { syncSystemRoles } from '../rbac/roles.service';

import type { SignupBody } from './auth.schema';
import { hashPassword, validatePasswordPolicy } from './password';
import { startSession, type AuthSession } from './session';

/** Finds a live (not removed) user by e-mail. */
export const findUserByEmail = (email: string) =>
  UserModel.findOne({ email: email.trim().toLowerCase() }).lean<UserDoc>();

/**
 * Signup (Phase 19): no e-mail. A business or a reseller fills the form and is logged in at
 * once: account (`kind`) + 5 system roles + wallet + verified owner in one transaction.
 * A taken e-mail answers 409 (accepted trade-off: the form says "log in instead").
 */
export const signup = async (
  req: Request,
  res: Response,
  body: z.infer<typeof SignupBody>,
): Promise<AuthSession> => {
  if (body.website) {
    getLogger().warn({ ip: req.ip ?? null }, 'signup_honeypot');
    throw new ValidationError([{ path: 'body', message: 'Invalid request' }]);
  }
  const settings = await getSignupSettings();
  if (!settings.open) throw new AppError('SIGNUP_CLOSED');
  const reseller = body.accountType === 'reseller';
  if (reseller && settings.resellerSignup === 'closed') {
    throw new AppError('SIGNUP_CLOSED', 'Reseller signups are closed. Contact us.', [
      { path: 'accountType', message: 'closed' },
    ]);
  }
  const email = body.email.trim().toLowerCase();
  const issues = validatePasswordPolicy(body.password, { email, name: body.name }, 'body.password');
  if (issues.length) throw new ValidationError(issues);
  if (await findUserByEmail(email)) throw new AppError('AUTH_EMAIL_TAKEN');

  const passwordHash = await hashPassword(body.password);
  const now = new Date();
  const owner = await withTransaction(async (session) => {
    const [account] = await AccountModel.create(
      [
        {
          name: body.businessName,
          slug: await uniqueSlug(body.businessName, session),
          kind: reseller ? 'reseller' : 'business',
          parentAccountId: null,
          reseller: reseller
            ? defaultResellerInfo(
                settings.resellerSignup === 'approval' ? 'pending_approval' : 'active',
              )
            : null,
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
          emailVerifiedAt: now,
          lastLoginAt: now,
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
  }).catch((err: unknown) => {
    // two signups with one e-mail at the same moment: the unique index decides
    if ((err as { code?: number }).code === 11000) throw new AppError('AUTH_EMAIL_TAKEN');
    throw err;
  });

  await recordAudit({
    accountId: owner.accountId,
    actor: { type: 'user', id: owner._id },
    action: 'account.signed_up',
    target: { type: 'account', id: owner.accountId.toString() },
    meta: { kind: reseller ? 'reseller' : 'business' },
    ip: req.ip ?? null,
  });
  if (reseller) await bellResellerSignup(owner.accountId, body.businessName);
  return startSession(req, res, owner._id);
};

/** Superadmins hear about every new reseller (they may need to approve it). */
const bellResellerSignup = async (accountId: Types.ObjectId, name: string) => {
  try {
    const admins = await UserModel.find({ platformRole: 'superadmin', status: 'active' })
      .select({ _id: 1, accountId: 1 })
      .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId }[]>();
    const platform = admins[0]?.accountId;
    if (!platform) return;
    await notify({
      accountId: platform,
      userIds: admins.map((a) => a._id),
      type: 'account.reseller_signed_up',
      title: 'A new reseller signed up',
      body: name,
      link: `/admin/accounts/${accountId.toString()}`,
    });
  } catch (err) {
    getLogger().error({ err }, 'signup: reseller bell failed');
  }
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
