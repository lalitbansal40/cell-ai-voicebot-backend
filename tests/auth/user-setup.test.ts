import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { migrateUp } from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/migrations';
import { AccountModel } from '../../src/db/models/account.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import { verifyPassword } from '../../src/modules/auth/password';
import { getPlatformAccount, upsertActiveUser } from '../../src/modules/auth/user-setup';
import { createLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';

useTestDb();

const PASSWORD = 'blue-tiger-river-42';

describe('upsertActiveUser (seed + superadmin CLI)', () => {
  it('fails clearly when the platform account is missing', async () => {
    await expect(getPlatformAccount()).rejects.toThrow('npm run db:migrate');
  });

  it('creates a verified superadmin in the platform account', async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no db');
    await migrateUp(db, MIGRATIONS, createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }));
    const platform = await getPlatformAccount();
    const res = await upsertActiveUser({
      accountId: platform._id,
      roleKey: 'owner',
      email: ' Root@Platform.Local ',
      name: 'Root Admin',
      password: PASSWORD,
      platformRole: 'superadmin',
      updatePassword: true,
    });
    expect(res.created).toBe(true);
    const user = await UserModel.findById(res.userId).lean();
    expect(user).toMatchObject({
      email: 'root@platform.local',
      status: 'active',
      platformRole: 'superadmin',
    });
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date);
    expect((await verifyPassword(user?.passwordHash ?? '', PASSWORD)).ok).toBe(true);
    expect(await RoleModel.countDocuments({ accountId: platform._id })).toBe(5);
  });

  it('updates the password + bumps tokenVersion when asked; keeps it otherwise', async () => {
    const platform = await getPlatformAccount();
    const before = await UserModel.findOne({ email: 'root@platform.local' }).lean();
    await upsertActiveUser({
      accountId: platform._id,
      roleKey: 'owner',
      email: 'root@platform.local',
      name: 'Root',
      password: 'green-falcon-lake-77',
      platformRole: 'superadmin',
      updatePassword: true,
    });
    const after = await UserModel.findOne({ email: 'root@platform.local' }).lean();
    expect(after?.tokenVersion).toBe((before?.tokenVersion ?? 0) + 1);
    expect((await verifyPassword(after?.passwordHash ?? '', 'green-falcon-lake-77')).ok).toBe(true);
    const again = await upsertActiveUser({
      accountId: platform._id,
      roleKey: 'owner',
      email: 'root@platform.local',
      name: 'Root',
      password: 'purple-otter-hill-31',
      platformRole: 'superadmin',
    });
    expect(again.created).toBe(false);
    const unchanged = await UserModel.findOne({ email: 'root@platform.local' }).lean();
    expect((await verifyPassword(unchanged?.passwordHash ?? '', 'green-falcon-lake-77')).ok).toBe(
      true,
    );
  });

  it('sets the account owner and refuses emails of another account or weak passwords', async () => {
    const account = await AccountModel.create({ name: 'Demo', slug: 'demo-x' });
    await upsertActiveUser({
      accountId: account._id,
      roleKey: 'owner',
      email: 'owner@demo.local',
      name: 'Owner',
      password: PASSWORD,
    });
    const fresh = await AccountModel.findById(account._id).lean();
    expect(fresh?.ownerId).toBeTruthy();
    const platform = await getPlatformAccount();
    await expect(
      upsertActiveUser({
        accountId: platform._id,
        roleKey: 'owner',
        email: 'owner@demo.local',
        name: 'X',
        password: PASSWORD,
      }),
    ).rejects.toThrow('another account');
    await expect(
      upsertActiveUser({
        accountId: account._id,
        roleKey: 'viewer',
        email: 'v@demo.local',
        name: 'V',
        password: '1234567890',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
