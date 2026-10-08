import { randomBytes } from 'node:crypto';

import type { Types } from 'mongoose';

import { AccountModel, type AccountDoc } from '../../src/db/models/account.model';
import { UserModel, type UserDoc } from '../../src/db/models/user.model';
import { hashPassword } from '../../src/modules/auth/password';
import { signAccessToken } from '../../src/modules/auth/tokens';
import { syncSystemRoles } from '../../src/modules/rbac/roles.service';
import type { SystemRoleKey } from '../../src/modules/rbac/system-roles';

export const TEST_PASSWORD = 'blue-tiger-river-42';
const uid = () => randomBytes(4).toString('hex');

let cachedHash: Promise<string> | undefined;
const passwordHash = () => (cachedHash ??= hashPassword(TEST_PASSWORD));

export interface TestUser {
  user: UserDoc;
  token: string;
  roleKey: SystemRoleKey;
}

export interface TestAccount {
  account: AccountDoc;
  roles: Record<SystemRoleKey, Types.ObjectId>;
  /** Adds a user with the given role (active + verified unless overridden). */
  addUser(roleKey: SystemRoleKey, overrides?: Partial<UserDoc>): Promise<TestUser>;
}

/** Access token for a user document (same claims as a real login). */
export const tokenFor = async (
  user: Pick<UserDoc, '_id' | 'accountId' | 'roleId' | 'tokenVersion'>,
  extra: { sid?: string; imp?: string; ttl?: string } = {},
): Promise<string> =>
  (
    await signAccessToken(
      {
        sub: user._id.toString(),
        acc: user.accountId.toString(),
        rid: user.roleId.toString(),
        tv: user.tokenVersion,
        sid: extra.sid ?? `test_${uid()}`,
        ...(extra.imp ? { imp: extra.imp } : {}),
      },
      extra.ttl ?? '15m',
    )
  ).token;

/** A fresh account with its 5 system roles. */
export const createTestAccount = async (
  overrides: Partial<AccountDoc> = {},
): Promise<TestAccount> => {
  const account = await AccountModel.create({
    name: `Test Co ${uid()}`,
    slug: `test-${uid()}`,
    ...overrides,
  });
  const roles = await syncSystemRoles(account._id);
  const addUser = async (roleKey: SystemRoleKey, extra: Partial<UserDoc> = {}) => {
    const created = await UserModel.create({
      accountId: account._id,
      roleId: roles[roleKey],
      name: `${roleKey} ${uid()}`,
      email: `${roleKey}-${uid()}@example.com`,
      passwordHash: await passwordHash(),
      status: 'active',
      emailVerifiedAt: new Date(),
      ...extra,
    });
    if (roleKey === 'owner' && !account.ownerId) {
      await AccountModel.updateOne({ _id: account._id }, { $set: { ownerId: created._id } });
    }
    const user = created.toObject({ transform: false }) as UserDoc;
    return { user, token: await tokenFor(user), roleKey };
  };
  return { account: account.toObject({ transform: false }), roles, addUser };
};
