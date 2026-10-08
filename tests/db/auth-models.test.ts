import type mongoose from 'mongoose';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { AuthCodeModel } from '../../src/db/models/auth-code.model';
import { RefreshTokenModel } from '../../src/db/models/refresh-token.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import { uniqueSlug } from '../../src/modules/account/slug';
import { syncSystemRoles } from '../../src/modules/rbac/roles.service';
import { SYSTEM_ROLES } from '../../src/modules/rbac/system-roles';
import { useTestDb } from '../helpers/db';

useTestDb();

const indexKeys = async (model: mongoose.Model<never>) =>
  (await model.collection.listIndexes().toArray()).map((i) => ({
    key: i.key as Record<string, number>,
    unique: Boolean(i.unique),
    ttl: i.expireAfterSeconds as number | undefined,
  }));

const newAccount = (slug = `acc-${new Types.ObjectId().toString().slice(-6)}`) =>
  AccountModel.create({ name: 'Demo Finance', slug });

describe('Account', () => {
  it('applies defaults (timezone, country, language, settings, status)', async () => {
    const account = await newAccount();
    expect(account.status).toBe('active');
    expect(account.timezone).toBe('Asia/Kolkata');
    expect(account.country).toBe('IN');
    expect(account.defaultLanguage).toBe('hinglish');
    expect(account.isPlatform).toBe(false);
    expect(account.settings.callingWindow).toMatchObject({
      start: '09:00',
      end: '19:00',
      days: [1, 2, 3, 4, 5, 6],
    });
    expect(account.settings.recordingEnabled).toBe(true);
    expect(account.settings.aiDisclosureEnabled).toBe(true);
    expect(account.toJSON()).toHaveProperty('id');
  });

  it('enforces a unique slug', async () => {
    await newAccount('dup-slug');
    await expect(newAccount('dup-slug')).rejects.toMatchObject({ code: 11000 });
    expect(await indexKeys(AccountModel as never)).toContainEqual({
      key: { slug: 1 },
      unique: true,
      ttl: undefined,
    });
  });

  it('uniqueSlug avoids taken and reserved slugs', async () => {
    await newAccount('acme-loans');
    expect(await uniqueSlug('Acme Loans')).toMatch(/^acme-loans-[a-f0-9]{4}$/);
    expect(await uniqueSlug('Platform')).toMatch(/^platform-[a-f0-9]{4}$/);
    expect(await uniqueSlug('Fresh Name Ltd')).toBe('fresh-name-ltd');
  });
});

describe('User', () => {
  const baseUser = (accountId: Types.ObjectId, email: string) => ({
    accountId,
    roleId: new Types.ObjectId(),
    name: 'Asha',
    email,
    status: 'active' as const,
    passwordHash: '$argon2id$fake',
    invite: {
      tokenHash: 'h',
      expiresAt: new Date(),
      invitedBy: new Types.ObjectId(),
      lastSentAt: new Date(),
    },
  });

  it('lowercases email and never serialises secrets', async () => {
    const account = await newAccount();
    const user = await UserModel.create(baseUser(account._id, '  Asha@Example.COM '));
    expect(user.email).toBe('asha@example.com');
    expect(user.tokenVersion).toBe(0);
    const json = JSON.stringify(user.toJSON());
    expect(json).not.toContain('passwordHash');
    expect(json).not.toContain('$argon2id');
    expect(json).not.toContain('tokenVersion');
    expect(json).not.toContain('tokenHash');
    expect(JSON.stringify(user.toObject())).not.toContain('passwordHash');
  });

  it('keeps email unique globally, but frees it after a soft delete', async () => {
    const a = await newAccount();
    const b = await newAccount();
    const user = await UserModel.create(baseUser(a._id, 'unique@example.com'));
    await expect(UserModel.create(baseUser(b._id, 'unique@example.com'))).rejects.toMatchObject({
      code: 11000,
    });
    await (user as unknown as { softDelete(): Promise<unknown> }).softDelete();
    await expect(UserModel.create(baseUser(b._id, 'unique@example.com'))).resolves.toBeTruthy();
  });

  it('has the account/status and invite-token indexes', async () => {
    const keys = (await indexKeys(UserModel as never)).map((i) => i.key);
    expect(keys).toContainEqual({ accountId: 1, status: 1 });
    expect(keys).toContainEqual({ 'invite.tokenHash': 1 });
    expect(keys).toContainEqual({ email: 1 });
  });

  it('rejects unknown statuses and platform roles', async () => {
    const account = await newAccount();
    await expect(
      UserModel.create({ ...baseUser(account._id, 'x1@example.com'), status: 'nope' } as never),
    ).rejects.toThrow();
    await expect(
      UserModel.create({
        ...baseUser(account._id, 'x2@example.com'),
        platformRole: 'god',
      } as never),
    ).rejects.toThrow();
  });
});

describe('Role + syncSystemRoles', () => {
  it('creates the 5 system roles once and keeps permissions in sync', async () => {
    const account = await newAccount();
    const ids = await syncSystemRoles(account._id);
    expect(Object.keys(ids).sort()).toEqual(['admin', 'agent', 'manager', 'owner', 'viewer']);
    await RoleModel.updateOne(
      { accountId: account._id, key: 'viewer' },
      { $set: { permissions: [] } },
    );
    const again = await syncSystemRoles(account._id);
    expect(again.viewer.toString()).toBe(ids.viewer.toString());
    expect(await RoleModel.countDocuments({ accountId: account._id })).toBe(5);
    const viewer = await RoleModel.findOne({ accountId: account._id, key: 'viewer' }).lean();
    expect(viewer?.permissions).toEqual(SYSTEM_ROLES.viewer.permissions);
    expect(viewer?.isSystem).toBe(true);
    expect((await indexKeys(RoleModel as never)).map((i) => i.key)).toContainEqual({
      accountId: 1,
      key: 1,
    });
  });
});

describe('RefreshToken, AuthCode, ApiKey indexes', () => {
  it('declares unique hashes and TTL indexes', async () => {
    const rt = await indexKeys(RefreshTokenModel as never);
    expect(rt).toContainEqual({ key: { tokenHash: 1 }, unique: true, ttl: undefined });
    expect(rt).toContainEqual({ key: { expiresAt: 1 }, unique: false, ttl: 0 });
    expect(rt.map((i) => i.key)).toContainEqual({ userId: 1, familyId: 1 });

    const codes = await indexKeys(AuthCodeModel as never);
    expect(codes).toContainEqual({ key: { userId: 1, purpose: 1 }, unique: true, ttl: undefined });
    expect(codes).toContainEqual({ key: { expiresAt: 1 }, unique: false, ttl: 0 });

    const keys = await indexKeys(ApiKeyModel as never);
    expect(keys).toContainEqual({ key: { keyHash: 1 }, unique: true, ttl: undefined });
    expect(keys.map((i) => i.key)).toContainEqual({ accountId: 1, revokedAt: 1 });
  });

  it('never serialises the API key hash', async () => {
    const key = await ApiKeyModel.create({
      accountId: new Types.ObjectId(),
      name: 'CRM',
      prefix: 'cav_test_abcd',
      keyHash: 'deadbeef'.repeat(8),
      scopes: ['calls:write'],
      createdBy: new Types.ObjectId(),
    });
    expect(JSON.stringify(key.toJSON())).not.toContain('deadbeef');
    expect(key.toJSON()).toMatchObject({ prefix: 'cav_test_abcd', scopes: ['calls:write'] });
  });
});

describe('AuditLog', () => {
  const entry = () => ({
    accountId: new Types.ObjectId(),
    actor: { type: 'user' as const, id: new Types.ObjectId() },
    action: 'team.invited',
    target: { type: 'user', id: 'u1' },
    meta: { roleKey: 'manager' },
  });

  it('stores entries with the account/time indexes', async () => {
    const log = await AuditLogModel.create(entry());
    expect(log.at).toBeInstanceOf(Date);
    const keys = (await indexKeys(AuditLogModel as never)).map((i) => i.key);
    expect(keys).toContainEqual({ accountId: 1, at: -1 });
    expect(keys).toContainEqual({ accountId: 1, action: 1, at: -1 });
  });

  it('is immutable (updates, deletes and re-saves throw)', async () => {
    const log = await AuditLogModel.create(entry());
    await expect(AuditLogModel.updateOne({ _id: log._id }, { action: 'x' })).rejects.toThrow(
      'immutable',
    );
    await expect(AuditLogModel.findOneAndUpdate({ _id: log._id }, { action: 'x' })).rejects.toThrow(
      'immutable',
    );
    await expect(AuditLogModel.deleteOne({ _id: log._id })).rejects.toThrow('immutable');
    await expect(AuditLogModel.deleteMany({ _id: log._id })).rejects.toThrow('immutable');
    log.action = 'changed';
    await expect(log.save()).rejects.toThrow('immutable');
  });

  it('allows the purge job to delete with allowPurge', async () => {
    const log = await AuditLogModel.create(entry());
    await AuditLogModel.deleteMany({ _id: log._id }, { allowPurge: true });
    expect(await AuditLogModel.countDocuments({ _id: log._id })).toBe(0);
  });
});
