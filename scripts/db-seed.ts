/**
 * DEV ONLY — demo data: account "Demo Finance" with one user per role and a
 * platform superadmin. Idempotent; existing users are left as they are.
 * Password: SEED_PASSWORD, else a random one printed once. Refuses in production.
 */
import { getEnv } from '../src/config/env';
import { AccountModel } from '../src/db/models/account.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { randomToken } from '../src/modules/auth/hmac';
import { getPlatformAccount, upsertActiveUser } from '../src/modules/auth/user-setup';
import type { SystemRoleKey } from '../src/modules/rbac/system-roles';
import { getLogger } from '../src/shared/logger';

const ROLES: SystemRoleKey[] = ['owner', 'admin', 'manager', 'agent', 'viewer'];

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('db:seed is disabled in production');
  const password = env.SEED_PASSWORD ?? `Seed-${randomToken(9)}`;
  await connectMongo(env, getLogger());
  try {
    const account =
      (await AccountModel.findOne({ slug: 'demo-finance' })) ??
      (await AccountModel.create({ name: 'Demo Finance', slug: 'demo-finance' }));
    const created: string[] = [];
    for (const role of ROLES) {
      const email = `${role}@demo.local`;
      const res = await upsertActiveUser({
        accountId: account._id,
        roleKey: role,
        email,
        name: `Demo ${role[0]?.toUpperCase()}${role.slice(1)}`,
        password,
      });
      if (res.created) created.push(email);
    }
    const platform = await getPlatformAccount();
    const admin = await upsertActiveUser({
      accountId: platform._id,
      roleKey: 'owner',
      email: 'admin@platform.local',
      name: 'Platform Admin',
      password,
      platformRole: 'superadmin',
    });
    if (admin.created) created.push('admin@platform.local');

    console.info(
      'Seed: account "Demo Finance" (demo-finance) + users <role>@demo.local + admin@platform.local',
    );
    if (created.length) {
      console.info(`Created: ${created.join(', ')}`);
      console.info(
        env.SEED_PASSWORD
          ? 'Password: SEED_PASSWORD from .env'
          : `Password (shown once): ${password}`,
      );
    } else {
      console.info('Nothing new — all seed users already exist.');
    }
  } finally {
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
