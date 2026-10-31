import { PUBLIC_API_LIMITS } from '../../config/limits';
import { parseCidr } from '../../shared/middlewares/api-key-auth';
import { registry } from '../../shared/openapi/registry';
import { apiKey, bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { API_KEY_SCOPE_INFO, API_KEY_SCOPES } from './scopes';

const name = z.string().trim().min(1).max(60);
const scopes = z
  .array(z.enum(API_KEY_SCOPES))
  .min(1)
  .refine((s) => new Set(s).size === s.length, 'Scopes must be unique');
const ipAllowlist = z
  .array(
    z
      .string()
      .trim()
      .max(50)
      .refine(
        (v) => parseCidr(v) !== null,
        'Use an IP address or a CIDR range like 203.0.113.0/24',
      ),
  )
  .max(PUBLIC_API_LIMITS.ipAllowlistMax)
  .openapi({ example: ['203.0.113.0/24', '2001:db8::/32'] });
const expiresAt = z.iso
  .datetime({ offset: true })
  .refine((v) => new Date(v).getTime() > Date.now(), 'Choose a time in the future')
  .nullable();

export const CreateApiKeyBody = z.strictObject({
  name,
  scopes,
  ipAllowlist: ipAllowlist.optional(),
  expiresAt: expiresAt.optional(),
});

export const UpdateApiKeyBody = z
  .strictObject({
    name: name.optional(),
    scopes: scopes.optional(),
    ipAllowlist: ipAllowlist.optional(),
    expiresAt: expiresAt.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one field');

export const ApiKeyRequestsQuery = z.strictObject({
  /** Cursor: the `nextCursor` of the previous page. */
  cursor: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const ApiKeyIdParams = z.strictObject({ id: ObjectIdSchema });

export const ApiKeySchema = registry.register(
  'ApiKey',
  z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().openapi({ example: 'cav_live_ab12' }),
    scopes: z.array(z.string()),
    ipAllowlist: z.array(z.string()),
    expiresAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    requests24h: z.number().int(),
    requests7d: z.number().int(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
);

export const ApiKeyScopeInfoSchema = registry.register(
  'ApiKeyScopeInfo',
  z.object({ scope: z.string(), group: z.string(), description: z.string() }),
);

export const ApiRequestLogSchema = registry.register(
  'ApiRequestLog',
  z.object({
    id: z.string(),
    method: z.string(),
    route: z.string().openapi({ example: '/api/v1/calls/:id' }),
    status: z.number().int(),
    ms: z.number().int(),
    requestId: z.string(),
    at: z.string(),
  }),
);

/** For `GET /api-keys/scopes` (the UI groups the picker by `group`). */
export const scopeCatalogue = () =>
  Object.entries(API_KEY_SCOPE_INFO).map(([scope, info]) => ({ scope, ...info }));

export const CreatedApiKeySchema = registry.register(
  'CreatedApiKey',
  z.object({
    apiKey: ApiKeySchema,
    key: z.string().openapi({ description: 'The full key — shown only once, store it now.' }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/api-keys',
  tags: ['API keys'],
  summary: 'API keys of the account (apikeys.read) — never the key itself',
  security: bearer,
  responses: { 200: ok(z.array(ApiKeySchema)), 401: errors[401], 403: errors[403] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/api-keys',
  tags: ['API keys'],
  summary: 'Create an API key (apikeys.manage; max 20 active). The full key is returned once.',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: CreateApiKeyBody } } } },
  responses: {
    201: ok(CreatedApiKeySchema, 'Created (Cache-Control: no-store)'),
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/api-keys/{id}',
  tags: ['API keys'],
  summary:
    'Change a key: name, scopes, IP allowlist, expiry (apikeys.manage; takes effect within 30 s)',
  security: bearer,
  request: {
    params: ApiKeyIdParams,
    body: { content: { 'application/json': { schema: UpdateApiKeyBody } } },
  },
  responses: { 200: ok(ApiKeySchema), 403: errors[403], 404: errors[404], 422: errors[422] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/api-keys/scopes',
  tags: ['API keys'],
  summary: 'Scope catalogue with groups (apikeys.read)',
  security: bearer,
  responses: { 200: ok(z.array(ApiKeyScopeInfoSchema)), 403: errors[403] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/api-keys/{id}/requests',
  tags: ['API keys'],
  summary: 'Requests made with a key, newest first (last 7 days; route templates only)',
  security: bearer,
  request: { params: ApiKeyIdParams, query: ApiKeyRequestsQuery },
  responses: {
    200: ok(z.object({ items: z.array(ApiRequestLogSchema), nextCursor: z.string().nullable() })),
    403: errors[403],
    404: errors[404],
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/v1/api-keys/{id}',
  tags: ['API keys'],
  summary: 'Revoke an API key (idempotent)',
  security: bearer,
  request: { params: ApiKeyIdParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/api-keys/whoami',
  tags: ['API keys', 'Public API'],
  summary: 'Check an API key (X-API-Key) — account, key id and scopes',
  security: apiKey,
  responses: {
    200: ok(z.object({ accountId: z.string(), apiKeyId: z.string(), scopes: z.array(z.string()) })),
    401: errors[401],
  },
});
