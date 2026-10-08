import { describe, expect, it } from 'vitest';

import { isPermission, PERMISSION_INFO, PERMISSIONS, PLATFORM_PERMISSIONS } from './permissions';
import { isSystemRoleKey, SYSTEM_ROLE_KEYS, SYSTEM_ROLES } from './system-roles';

const WRITE = /\.(write|manage|update|invite|remove|topup|publish|run|export|import)$/;

describe('permission catalogue', () => {
  it('uses domain.action keys with a group and description', () => {
    for (const key of PERMISSIONS) {
      expect(key).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(PERMISSION_INFO[key].group.length).toBeGreaterThan(0);
      expect(PERMISSION_INFO[key].description.length).toBeGreaterThan(5);
    }
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('keeps platform permissions out of the account catalogue', () => {
    for (const p of PLATFORM_PERMISSIONS) expect(isPermission(p)).toBe(false);
    expect(isPermission('team.invite')).toBe(true);
    expect(isPermission('toString')).toBe(false);
  });
});

describe('system roles', () => {
  const set = (key: keyof typeof SYSTEM_ROLES) => new Set<string>(SYSTEM_ROLES[key].permissions);

  it('defines exactly the five built-in roles', () => {
    expect(Object.keys(SYSTEM_ROLES)).toEqual([...SYSTEM_ROLE_KEYS]);
    expect(isSystemRoleKey('admin')).toBe(true);
    expect(isSystemRoleKey('superadmin')).toBe(false);
  });

  it('only uses catalogue permissions, without duplicates', () => {
    for (const key of SYSTEM_ROLE_KEYS) {
      const perms = SYSTEM_ROLES[key].permissions;
      for (const p of perms) expect(isPermission(p)).toBe(true);
      expect(new Set(perms).size).toBe(perms.length);
    }
  });

  it('owner and admin have every permission; manager ⊆ admin', () => {
    expect(set('owner')).toEqual(new Set(PERMISSIONS));
    expect(set('admin')).toEqual(new Set(PERMISSIONS));
    for (const p of set('manager')) expect(set('admin').has(p)).toBe(true);
  });

  it('manager cannot administer the account', () => {
    for (const p of [
      'account.update',
      'team.invite',
      'team.update',
      'team.remove',
      'apikeys.read',
      'apikeys.manage',
      'audit.read',
      'wallet.topup',
      'integrations.manage',
      'telephony.manage',
      'dnd.manage',
    ]) {
      expect(set('manager').has(p)).toBe(false);
    }
  });

  it('agent and viewer have no write / admin permissions except agent call actions', () => {
    for (const p of set('viewer')) expect(p).not.toMatch(WRITE);
    for (const p of set('agent')) {
      if (p === 'calls.trigger' || p === 'calls.listen') continue;
      expect(p).not.toMatch(WRITE);
    }
    expect(set('agent').has('calls.trigger')).toBe(true);
    expect(set('viewer').has('calls.trigger')).toBe(false);
    expect(set('viewer').has('wallet.read')).toBe(true);
    expect(set('agent').has('wallet.read')).toBe(false);
  });

  it('matches the role matrix of PHASE_2_PLAN §1b', () => {
    expect(
      Object.fromEntries(SYSTEM_ROLE_KEYS.map((k) => [k, [...SYSTEM_ROLES[k].permissions].sort()])),
    ).toMatchSnapshot();
  });
});
