import { PERMISSIONS, type Permission } from './permissions';

export const SYSTEM_ROLE_KEYS = ['owner', 'admin', 'manager', 'agent', 'viewer'] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

const MANAGER: Permission[] = [
  'account.read',
  'team.read',
  'contacts.read',
  'contacts.write',
  'contacts.import',
  'contacts.export',
  'wallet.read',
  'agents.read',
  'agents.write',
  'flows.read',
  'flows.write',
  'flows.publish',
  'calls.read',
  'calls.trigger',
  'calls.listen',
  'calls.export',
  'campaigns.read',
  'campaigns.write',
  'campaigns.run',
  'reports.read',
  'reports.export',
];

const AGENT: Permission[] = [
  'account.read',
  'contacts.read',
  'agents.read',
  'flows.read',
  'calls.read',
  'calls.trigger',
  'calls.listen',
  'campaigns.read',
];

const VIEWER: Permission[] = [
  'account.read',
  'contacts.read',
  'wallet.read',
  'agents.read',
  'flows.read',
  'calls.read',
  'campaigns.read',
  'reports.read',
];

/**
 * Built-in roles created for every account (PHASE_2_PLAN §1b role matrix).
 * Changing a list here needs a migration that calls `syncSystemRoles()`.
 * Owner-only actions (ownership transfer) are checked in code, not here.
 */
export const SYSTEM_ROLES: Record<SystemRoleKey, { name: string; permissions: Permission[] }> = {
  owner: { name: 'Owner', permissions: [...PERMISSIONS] },
  admin: { name: 'Admin', permissions: [...PERMISSIONS] },
  manager: { name: 'Manager', permissions: MANAGER },
  agent: { name: 'Agent', permissions: AGENT },
  viewer: { name: 'Viewer', permissions: VIEWER },
};

export const isSystemRoleKey = (value: string): value is SystemRoleKey =>
  (SYSTEM_ROLE_KEYS as readonly string[]).includes(value);
