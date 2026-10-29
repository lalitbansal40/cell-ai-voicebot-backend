import type { Permission } from '../rbac/permissions';

/**
 * Public-API key scopes (api.md §12). A route opens to keys with
 * `access({ permission, scope })`; `group` orders the scope picker in the UI.
 */
export const API_KEY_SCOPE_INFO = {
  'calls:read': { group: 'Calls', description: 'Read call records and results' },
  'calls:write': { group: 'Calls', description: 'Trigger calls' },
  'whatsapp-calls:write': { group: 'Calls', description: 'Start WhatsApp calls with an AI agent' },
  'contacts:read': { group: 'Contacts', description: 'Read contacts' },
  'contacts:write': { group: 'Contacts', description: 'Create and update contacts' },
  'campaigns:read': { group: 'Campaigns', description: 'Read campaigns and their status' },
  'campaigns:write': { group: 'Campaigns', description: 'Create and control campaigns' },
  'messages:read': { group: 'WhatsApp', description: 'Read WhatsApp messages sent by the API' },
  'messages:write': { group: 'WhatsApp', description: 'Send WhatsApp messages and templates' },
  'templates:read': { group: 'WhatsApp', description: 'Read approved WhatsApp templates' },
  'reports:read': { group: 'Reports', description: 'Read report numbers' },
  'exports:write': { group: 'Reports', description: 'Create and download exports' },
  'webhooks:manage': { group: 'Webhooks', description: 'Manage outbound webhooks' },
} as const satisfies Record<string, { group: ApiKeyScopeGroup; description: string }>;

export type ApiKeyScopeGroup =
  'Calls' | 'Contacts' | 'Campaigns' | 'WhatsApp' | 'Reports' | 'Webhooks';
export type ApiKeyScope = keyof typeof API_KEY_SCOPE_INFO;
export const API_KEY_SCOPES = Object.keys(API_KEY_SCOPE_INFO) as [ApiKeyScope, ...ApiKeyScope[]];

/**
 * What a scope lets the shared services do (ADR 0045). Keys never pass
 * `requirePermission` — routes open to keys only through `access({ scope })` —
 * but the services check permissions too (e.g. a flow call needs `flows.read`).
 * Keys never get `contacts.export`, so exports never carry phone numbers.
 */
export const SCOPE_PERMISSIONS: Record<ApiKeyScope, readonly Permission[]> = {
  'calls:read': ['calls.read'],
  'calls:write': ['calls.trigger', 'flows.read', 'agents.read'],
  'whatsapp-calls:write': ['calls.trigger', 'flows.read', 'agents.read'],
  'contacts:read': ['contacts.read'],
  'contacts:write': ['contacts.write'],
  'campaigns:read': ['campaigns.read'],
  'campaigns:write': ['campaigns.write', 'campaigns.run'],
  'messages:read': ['inbox.read'],
  'messages:write': ['inbox.reply'],
  'templates:read': ['templates.read'],
  'reports:read': ['reports.read'],
  'exports:write': ['calls.export', 'reports.export'],
  'webhooks:manage': ['integrations.manage'],
};

/** The service-level permissions of a key's scopes (unknown scopes give nothing). */
export const permissionsForScopes = (scopes: Iterable<string>): Set<string> => {
  const out = new Set<string>();
  for (const scope of scopes) {
    const perms = (SCOPE_PERMISSIONS as Record<string, readonly Permission[] | undefined>)[scope];
    for (const p of perms ?? []) out.add(p);
  }
  return out;
};
