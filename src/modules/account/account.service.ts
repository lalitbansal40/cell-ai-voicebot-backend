import type { Request } from 'express';
import type { z } from 'zod';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import { notifyAccount } from '../../core/realtime/notify';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { ForbiddenError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { toPublicAccount, type PublicAccount } from '../auth/session';

import type { CALLING_WINDOW_WARNINGS, UpdateAccountBody } from './account.schema';

type WindowWarning = (typeof CALLING_WINDOW_WARNINGS)[number] | null;

/** Live calls are held to 09:00–21:00 (TRAI) and recovery calls to 08:00–19:00 (RBI). */
export const callingWindowWarning = (window: { start: string; end: string }): WindowWarning => {
  const { trafficHardWindow: trai, recoveryHardWindow: rbi } = CAMPAIGN_LIMITS;
  if (window.start < trai.start || window.end > trai.end) return 'outside_trai';
  if (window.start < rbi.start || window.end > rbi.end) return 'outside_rbi_recovery';
  return null;
};

const withWarning = (account: AccountDoc) => ({
  ...toPublicAccount(account),
  callingWindowWarning: callingWindowWarning(account.settings.callingWindow),
});

export const getAccount = async (
  req: Request,
): Promise<PublicAccount & { callingWindowWarning: WindowWarning }> => {
  const account = await AccountModel.findById(requireAuth(req).accountId).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  return withWarning(account);
};

/** Partial update; nested `settings.*` keys are merged, never replaced wholesale. */
export const updateAccount = async (
  req: Request,
  body: z.infer<typeof UpdateAccountBody>,
): Promise<PublicAccount & { callingWindowWarning: WindowWarning }> => {
  const auth = requireAuth(req);
  // call caps limit how often borrowers are called: owners / admins only
  if (body.settings?.callCaps && !['owner', 'admin'].includes(auth.roleKey ?? '')) {
    throw new ForbiddenError('Only owners and admins can change the call limits.');
  }
  const $set: Record<string, unknown> = {};
  for (const key of ['name', 'timezone', 'country', 'defaultLanguage'] as const) {
    if (body[key] !== undefined) $set[key] = body[key];
  }
  for (const [key, value] of Object.entries(body.settings ?? {})) {
    if (value !== undefined) $set[`settings.${key}`] = value;
  }
  const account = await AccountModel.findOneAndUpdate(
    { _id: auth.accountId },
    { $set },
    { returnDocument: 'after', runValidators: true },
  ).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  const fields = Object.keys($set);
  await auditRequest(req, 'account.updated', {
    target: { type: 'account', id: auth.accountId },
    meta: { fields },
  });
  notifyAccount(auth.accountId, 'account.updated', { fields });
  return withWarning(account);
};
