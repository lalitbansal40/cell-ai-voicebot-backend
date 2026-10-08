import mongoose, { type Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { AccountModel } from '../../src/db/models/account.model';
import { RoleModel } from '../../src/db/models/role.model';
import { useTestDb } from '../helpers/db';

useTestDb();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0004-dnd-manage-permission');
  if (!found) throw new Error('0004 missing');
  return found;
};
const perms = async (accountId: Types.ObjectId, key: string): Promise<string[]> =>
  (await RoleModel.findOne({ accountId, key }).lean<{ permissions: string[] }>())?.permissions ??
  [];

describe('0004-dnd-manage-permission', () => {
  it('is registered right after 0003', () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0004-dnd-manage-permission')).toBe(
      names.indexOf('0003-sync-system-roles') + 1,
    );
  });

  it('gives dnd.manage to owner and admin only; idempotent; down removes it', async () => {
    const account = await AccountModel.create({ name: 'Old Co', slug: 'old-co-p3' });
    await RoleModel.create({
      accountId: account._id,
      key: 'owner',
      name: 'Owner',
      isSystem: true,
      permissions: ['contacts.read'],
    });
    await migration().up(db());
    await migration().up(db());

    expect(await perms(account._id, 'owner')).toContain('dnd.manage');
    expect(await perms(account._id, 'admin')).toContain('dnd.manage');
    for (const key of ['manager', 'agent', 'viewer']) {
      expect(await perms(account._id, key)).not.toContain('dnd.manage');
    }
    expect(await RoleModel.countDocuments({ accountId: account._id })).toBe(5);

    await migration().down(db());
    expect(await perms(account._id, 'owner')).not.toContain('dnd.manage');
    expect(await perms(account._id, 'owner')).toContain('contacts.read');
  });
});
