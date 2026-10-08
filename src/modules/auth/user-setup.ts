import type { Types } from 'mongoose';

import { AccountModel } from '../../db/models/account.model';
import { UserModel } from '../../db/models/user.model';
import { ValidationError } from '../../shared/errors/app-error';
import { syncSystemRoles } from '../rbac/roles.service';
import type { SystemRoleKey } from '../rbac/system-roles';

import { hashPassword, validatePasswordPolicy } from './password';

/** The internal `platform` account (migration 0002). */
export const getPlatformAccount = async () => {
  const platform = await AccountModel.findOne({ slug: 'platform', isPlatform: true });
  if (!platform) throw new Error('Platform account missing — run "npm run db:migrate"');
  return platform;
};

/**
 * Creates or updates an active, verified user (CLI + seed only — HTTP flows
 * have their own services). Returns whether the user was created.
 */
export const upsertActiveUser = async (input: {
  accountId: Types.ObjectId;
  roleKey: SystemRoleKey;
  email: string;
  name: string;
  password: string;
  platformRole?: 'superadmin' | null;
  updatePassword?: boolean;
}): Promise<{ created: boolean; userId: Types.ObjectId }> => {
  const email = input.email.trim().toLowerCase();
  const issues = validatePasswordPolicy(input.password, { email, name: input.name });
  if (issues.length) throw new ValidationError(issues);
  const roles = await syncSystemRoles(input.accountId);
  const existing = await UserModel.findOne({ email });
  if (existing && existing.accountId.toString() !== input.accountId.toString()) {
    throw new Error(`${email} already belongs to another account`);
  }
  if (existing) {
    existing.name = input.name;
    existing.roleId = roles[input.roleKey];
    existing.status = 'active';
    existing.emailVerifiedAt ??= new Date();
    existing.platformRole = input.platformRole ?? null;
    if (input.updatePassword) {
      existing.passwordHash = await hashPassword(input.password);
      existing.passwordChangedAt = new Date();
      existing.tokenVersion += 1;
    }
    await existing.save();
    return { created: false, userId: existing._id };
  }
  const user = await UserModel.create({
    accountId: input.accountId,
    roleId: roles[input.roleKey],
    name: input.name,
    email,
    passwordHash: await hashPassword(input.password),
    status: 'active',
    emailVerifiedAt: new Date(),
    platformRole: input.platformRole ?? null,
  });
  if (input.roleKey === 'owner') {
    await AccountModel.updateOne(
      { _id: input.accountId, ownerId: null },
      { $set: { ownerId: user._id } },
    );
  }
  return { created: true, userId: user._id };
};
