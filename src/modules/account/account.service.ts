import type { Request } from 'express';
import type { z } from 'zod';

import { notifyAccount } from '../../core/realtime/notify';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { toPublicAccount, type PublicAccount } from '../auth/session';

import type { UpdateAccountBody } from './account.schema';

export const getAccount = async (req: Request): Promise<PublicAccount> => {
  const account = await AccountModel.findById(requireAuth(req).accountId).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  return toPublicAccount(account);
};

/** Partial update; nested `settings.*` keys are merged, never replaced wholesale. */
export const updateAccount = async (
  req: Request,
  body: z.infer<typeof UpdateAccountBody>,
): Promise<PublicAccount> => {
  const auth = requireAuth(req);
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
    { new: true, runValidators: true },
  ).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  const fields = Object.keys($set);
  await auditRequest(req, 'account.updated', {
    target: { type: 'account', id: auth.accountId },
    meta: { fields },
  });
  notifyAccount(auth.accountId, 'account.updated', { fields });
  return toPublicAccount(account);
};
