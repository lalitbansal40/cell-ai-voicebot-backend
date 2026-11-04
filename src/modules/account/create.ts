import type { Types } from 'mongoose';

import { createWallet } from '../../core/billing/wallets';
import {
  AccountModel,
  defaultResellerInfo,
  type AccountDoc,
  type AccountKind,
  type ResellerStatus,
} from '../../db/models/account.model';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import { withTransaction } from '../../db/transaction';
import { ConflictError, ValidationError } from '../../shared/errors/app-error';
import { hashPassword, validatePasswordPolicy } from '../auth/password';
import { syncSystemRoles } from '../rbac/roles.service';

import { uniqueSlug } from './slug';

export interface NewAccountInput {
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPassword: string;
  ownerPhone?: string | undefined;
  timezone?: string | undefined;
  kind?: Exclude<AccountKind, 'platform'>;
  /** A business under this reseller. */
  parentAccountId?: Types.ObjectId | null;
  resellerStatus?: ResellerStatus;
}

const duplicate = () =>
  new ConflictError('CONFLICT_DUPLICATE', 'This e-mail already belongs to a user.');

/**
 * Account + 5 system roles + wallet + an active, verified owner with the given password, in
 * one transaction (superadmin and reseller "create account"; no e-mail is sent).
 */
export const createAccountWithOwner = async (
  input: NewAccountInput,
): Promise<{ account: AccountDoc; owner: UserDoc }> => {
  const email = input.ownerEmail.trim().toLowerCase();
  if (await UserModel.exists({ email })) throw duplicate();
  const issues = validatePasswordPolicy(
    input.ownerPassword,
    { email, name: input.ownerName },
    'body.ownerPassword',
  );
  if (issues.length) throw new ValidationError(issues);
  const passwordHash = await hashPassword(input.ownerPassword);
  const now = new Date();
  const kind = input.kind ?? 'business';
  try {
    return await withTransaction(async (session) => {
      const [account] = await AccountModel.create(
        [
          {
            name: input.businessName,
            slug: await uniqueSlug(input.businessName, session),
            kind,
            parentAccountId: kind === 'business' ? (input.parentAccountId ?? null) : null,
            reseller: kind === 'reseller' ? defaultResellerInfo(input.resellerStatus) : null,
            ...(input.timezone ? { timezone: input.timezone } : {}),
          },
        ],
        { session },
      );
      if (!account) throw new Error('account not created');
      const roles = await syncSystemRoles(account._id, session);
      await createWallet(account._id, session);
      const [owner] = await UserModel.create(
        [
          {
            accountId: account._id,
            roleId: roles.owner,
            name: input.ownerName,
            email,
            phone: input.ownerPhone ?? null,
            passwordHash,
            passwordChangedAt: now,
            status: 'active',
            emailVerifiedAt: now,
          },
        ],
        { session },
      );
      if (!owner) throw new Error('user not created');
      account.ownerId = owner._id;
      await account.save({ session });
      return { account: account.toObject({ transform: false }), owner: owner.toObject() };
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) throw duplicate();
    throw err;
  }
};
