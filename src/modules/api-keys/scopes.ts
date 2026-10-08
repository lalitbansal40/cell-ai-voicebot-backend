/**
 * Public-API key scopes (api.md §12). Phase 10 may add more; routes use
 * `apiKeyAuth({ scopes: ['calls:write'] })`.
 */
export const API_KEY_SCOPE_INFO = {
  'calls:read': 'Read call records and results',
  'calls:write': 'Trigger calls',
  'contacts:read': 'Read contacts',
  'contacts:write': 'Create and update contacts',
  'campaigns:read': 'Read campaigns and their status',
  'campaigns:write': 'Create and control campaigns',
  'webhooks:manage': 'Manage outbound webhooks',
} as const;

export type ApiKeyScope = keyof typeof API_KEY_SCOPE_INFO;
export const API_KEY_SCOPES = Object.keys(API_KEY_SCOPE_INFO) as [ApiKeyScope, ...ApiKeyScope[]];
