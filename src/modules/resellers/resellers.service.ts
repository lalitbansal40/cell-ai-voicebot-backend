import type { Request } from 'express';
import { Types } from 'mongoose';

import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { kindOf } from '../account/kinds';
import { startLoginAs } from '../auth/login-as';
import type { AuthSession } from '../auth/session';

/**
 * Phase 19 reseller panel. This module is the only code that reads accounts by
 * `parentAccountId`; a customer not under the caller's reseller account is always a 404.
 */

/** The caller's account when it is a reseller (else 404 — the panel doesn't exist for it). */
export const callerReseller = async (req: Request): Promise<AccountDoc> => {
  const auth = requireAuth(req);
  const account = await AccountModel.findById(auth.accountId).lean<AccountDoc>();
  if (!account || kindOf(account) !== 'reseller') throw new NotFoundError();
  return account;
};

/** Creating customers and moving credit need an approved reseller. */
export const assertApproved = (reseller: AccountDoc): void => {
  if ((reseller.reseller?.status ?? 'active') !== 'active') {
    throw new AppError('RESELLER_NOT_APPROVED');
  }
};

/** One of this reseller's customers (404 otherwise). */
export const findCustomer = async (reseller: AccountDoc, id: string): Promise<AccountDoc> => {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError();
  const customer = await AccountModel.findOne({
    _id: new Types.ObjectId(id),
    kind: 'business',
    parentAccountId: reseller._id,
    status: { $ne: 'deleted' },
  }).lean<AccountDoc>();
  if (!customer) throw new NotFoundError();
  return customer;
};

/** `POST /reseller/customers/:id/login-as` — act as the customer's owner (sensitive actions refused). */
export const loginAsCustomer = async (req: Request, customerId: string): Promise<AuthSession> => {
  const reseller = await callerReseller(req);
  assertApproved(reseller);
  const customer = await findCustomer(reseller, customerId);
  return startLoginAs(req, customer, {
    mode: 'act',
    kind: 'reseller',
    action: 'reseller.login_as_started',
  });
};
