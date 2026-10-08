/**
 * Permission catalogue (PHASE_2_PLAN §1b) — the ONLY place permissions are
 * defined. Format `domain.action`. Later phases use these; they don't add
 * new strings without updating this file, the role matrix and the plan.
 */
export const PERMISSION_INFO = {
  'account.read': { group: 'Account', description: 'View account details and settings' },
  'account.update': { group: 'Account', description: 'Change account settings' },
  'team.read': { group: 'Team', description: 'View team members and invites' },
  'team.invite': { group: 'Team', description: 'Invite members, resend or revoke invites' },
  'team.update': { group: 'Team', description: 'Change roles, enable or disable members' },
  'team.remove': { group: 'Team', description: 'Remove members' },
  'apikeys.read': { group: 'API keys', description: 'View API keys' },
  'apikeys.manage': { group: 'API keys', description: 'Create and revoke API keys' },
  'audit.read': { group: 'Audit', description: 'View the audit log' },
  'contacts.read': { group: 'Contacts', description: 'View contacts and lists' },
  'contacts.write': { group: 'Contacts', description: 'Create, edit and delete contacts' },
  'contacts.import': { group: 'Contacts', description: 'Import contacts from files' },
  'contacts.export': { group: 'Contacts', description: 'Export contacts' },
  'wallet.read': { group: 'Wallet', description: 'View balance, ledger and invoices' },
  'wallet.topup': { group: 'Wallet', description: 'Top up the wallet' },
  'agents.read': { group: 'AI agents', description: 'View AI agents' },
  'agents.write': { group: 'AI agents', description: 'Create and edit AI agents' },
  'flows.read': { group: 'Flows', description: 'View call flows' },
  'flows.write': { group: 'Flows', description: 'Create and edit call flows' },
  'flows.publish': { group: 'Flows', description: 'Publish call flow versions' },
  'calls.read': { group: 'Calls', description: 'View calls and transcripts' },
  'calls.trigger': { group: 'Calls', description: 'Start single calls' },
  'calls.listen': { group: 'Calls', description: 'Play call recordings' },
  'calls.export': { group: 'Calls', description: 'Export call records' },
  'campaigns.read': { group: 'Campaigns', description: 'View campaigns' },
  'campaigns.write': { group: 'Campaigns', description: 'Create and edit campaigns' },
  'campaigns.run': { group: 'Campaigns', description: 'Start, pause and stop campaigns' },
  'reports.read': { group: 'Reports', description: 'View reports and analytics' },
  'reports.export': { group: 'Reports', description: 'Export reports' },
  'integrations.manage': { group: 'Integrations', description: 'Manage webhooks and integrations' },
  'telephony.manage': { group: 'Integrations', description: 'Manage telephony (SIP) settings' },
} as const;

export type Permission = keyof typeof PERMISSION_INFO;

export const PERMISSIONS = Object.keys(PERMISSION_INFO) as Permission[];

/** Platform (superadmin) permissions — never part of an account role. */
export const PLATFORM_PERMISSIONS = [
  'platform.accounts.read',
  'platform.accounts.manage',
  'platform.impersonate',
] as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const isPermission = (value: string): value is Permission =>
  Object.hasOwn(PERMISSION_INFO, value);
