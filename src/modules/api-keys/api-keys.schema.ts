import { registry } from '../../shared/openapi/registry';
import { apiKey, bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { API_KEY_SCOPES } from './scopes';

export const CreateApiKeyBody = z.strictObject({
  name: z.string().trim().min(1).max(60),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1)
    .refine((s) => new Set(s).size === s.length, 'Scopes must be unique'),
});

export const ApiKeyIdParams = z.strictObject({ id: ObjectIdSchema });

export const ApiKeySchema = registry.register(
  'ApiKey',
  z.object({
    id: z.string(),
    name: z.string(),
    prefix: z.string().openapi({ example: 'cav_live_ab12' }),
    scopes: z.array(z.string()),
    lastUsedAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
    createdBy: z.string(),
    createdAt: z.string(),
  }),
);

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
  tags: ['API keys'],
  summary: 'Check an API key (X-API-Key) — account, key id and scopes',
  security: apiKey,
  responses: {
    200: ok(z.object({ accountId: z.string(), apiKeyId: z.string(), scopes: z.array(z.string()) })),
    401: errors[401],
  },
});
