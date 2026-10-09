import mongoose, { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { migrateDown, migrateUp } from '../../src/db/migrate';
import { MIGRATIONS } from '../../src/db/migrations';
import { AccountModel } from '../../src/db/models/account.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import { createLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';

useTestDb();

const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};

describe('phase 2 migrations', () => {
  it('registers 0002 and 0003 after the baseline', () => {
    expect(MIGRATIONS.map((m) => m.name).slice(0, 3)).toEqual([
      '0001-baseline',
      '0002-platform-account',
      '0003-sync-system-roles',
    ]);
  });

  it('creates the platform account and system roles for existing accounts, idempotently', async () => {
    const existing = await AccountModel.create({ name: 'Old Co', slug: 'old-co' });
    await migrateUp(db(), MIGRATIONS, logger);
    await migrateUp(db(), MIGRATIONS, logger);

    const platform = await AccountModel.findOne({ slug: 'platform' }).lean();
    expect(platform?.isPlatform).toBe(true);
    expect(await AccountModel.countDocuments({ slug: 'platform' })).toBe(1);
    expect(await RoleModel.countDocuments({ accountId: existing._id })).toBe(5);
    expect(await RoleModel.countDocuments({ accountId: platform?._id })).toBe(0);

    // 0003 re-run directly is idempotent too
    await MIGRATIONS[2]?.up(db());
    expect(await RoleModel.countDocuments({ accountId: existing._id })).toBe(5);
  });

  it('refuses to drop the platform account while superadmins exist', async () => {
    const platform = await AccountModel.findOne({ slug: 'platform' });
    if (!platform) throw new Error('platform missing');
    const admin = await UserModel.create({
      accountId: platform._id,
      roleId: new Types.ObjectId(),
      name: 'Root',
      email: 'root@platform.local',
      status: 'active',
      platformRole: 'superadmin',
    });
    await expect(MIGRATIONS[1]?.down(db())).rejects.toThrow('Platform account still has users');
    await UserModel.deleteOne({ _id: admin._id });
    // down 0005 (Phase 4, empty ledger), 0004 and 0003 are role / wallet only, then 0002
    // removes the platform account
    await migrateDown(db(), MIGRATIONS, logger);
    await migrateDown(db(), MIGRATIONS, logger);
    await migrateDown(db(), MIGRATIONS, logger);
    await migrateDown(db(), MIGRATIONS, logger);
    expect(await AccountModel.countDocuments({ slug: 'platform' })).toBe(0);
  });
});
