import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

/** VAPI: recorded-voice / IVR campaigns over the Cell24x7 Voice API. */

const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Must be an id');

export const VoiceAccountParams = z.strictObject({ id: objectId });

export const AccountVoiceApiBody = z
  .strictObject({
    enabled: z.boolean(),
    ivrIds: z.array(z.number().int().positive().max(2_147_483_647)).max(50),
    ivrEstimateSec: z.number().int().min(15).max(120),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const AccountVoiceApiSchema = registry.register(
  'AccountVoiceApi',
  z.object({
    enabled: z.boolean(),
    ivrIds: z.array(z.number().int()),
    ivrEstimateSec: z.number().int(),
  }),
);

/** Per-account Cell24x7 login: the platform token, or the account's own (checked, sealed). */
export const VoiceCredentialsBody = z
  .discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('platform') }),
    z.strictObject({
      mode: z.literal('own'),
      /** Omit to keep the saved token (e.g. only the caller ID changes). */
      token: z.string().trim().min(8).max(500).optional(),
      callerId: z
        .string()
        .trim()
        .regex(/^\d{10}$/, 'Use the 10-digit caller ID Cell24x7 gave this account')
        .nullable()
        .optional(),
    }),
  ])
  .openapi('VoiceCredentialsBody');

export const VoiceCredentialsSchema = registry.register(
  'VoiceCredentials',
  z.object({
    mode: z.enum(['platform', 'own']),
    /** Last 4 characters of the account's token (never the token). */
    tokenHint: z.string().nullable(),
    callerId: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    webhookRegisteredAt: z.string().nullable(),
  }),
);

/** `account` (not `accountId`): ids from a URL never pick a tenant — the key decides. */
export const AccountVoiceWebhookParams = z.strictObject({
  account: objectId,
  key: z.string().min(1).max(200),
});

export const VoiceIvrSchema = registry.register(
  'VoiceIvr',
  z.object({ id: z.number().int(), name: z.string() }),
);

export const AdminVoiceIvrSchema = registry.register(
  'AdminVoiceIvr',
  z.object({ id: z.number().int(), name: z.string(), runnable: z.boolean() }),
);

export const VoiceBatchParams = z.strictObject({
  id: objectId,
  no: z.coerce.number().int().min(1).max(1_000_000),
});

export const ResolveVoiceBatchBody = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('submitted'),
    requestId: z.string().trim().min(1).max(100),
  }),
  z.strictObject({ outcome: z.literal('not_submitted') }),
]);

export const VoiceStatusSchema = registry.register(
  'AdminVoiceStatus',
  z.object({
    provider: z.enum(['off', 'fake', 'cell24x7']),
    tokenConfigured: z.boolean(),
    webhook: z.object({
      registered: z.boolean(),
      matches: z.boolean().openapi({ description: 'Cell24x7 posts to this server' }),
      error: z.string().nullable(),
    }),
    lastWebhookAt: z.string().nullable(),
    lastError: z.object({ code: z.string(), at: z.string() }).nullable(),
    uncertainBatches: z.array(
      z.object({
        campaignId: z.string(),
        campaignName: z.string(),
        accountId: z.string(),
        batchNo: z.number().int(),
        count: z.number().int(),
        broadcastName: z.string().openapi({ description: 'Name in the Cell24x7 dashboard' }),
        error: z.string().nullable(),
        createdAt: z.string(),
      }),
    ),
  }),
);

/** The provider's result webhook (Cell24x7 PDF; no signature — secret path + polling check). */
export const VoiceWebhookParams = z.strictObject({ secret: z.string().min(1).max(200) });
export const VoiceWebhookBody = z
  .object({
    event: z.string().max(60).optional(),
    request_id: z.string().min(1).max(100),
    receiver: z.union([z.string().max(20), z.number()]),
    status: z.string().min(1).max(40),
    duration: z
      .union([z.number(), z.string().max(10)])
      .nullable()
      .optional(),
    retry_count: z
      .union([z.number(), z.string().max(5)])
      .nullable()
      .optional(),
    ivr: z
      .object({
        digits_pressed: z.string().max(64).nullable().optional(),
        disposition: z.string().max(100).nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const adminTags = ['Admin'];
const tags = ['Voice API'];

registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/voice-api',
  tags: adminTags,
  summary: 'Turn recorded-voice campaigns on / off, assign Cell24x7 IVRs (superadmin)',
  security: bearer,
  request: {
    params: VoiceAccountParams,
    body: { content: { 'application/json': { schema: AccountVoiceApiBody } } },
  },
  responses: {
    200: ok(AccountVoiceApiSchema),
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/admin/accounts/{id}/voice-api/credentials',
  tags: adminTags,
  summary:
    "The account's Cell24x7 login: the platform token, or its own token + caller ID (checked with Cell24x7 first, sealed; superadmin) — a refused token answers VOICE_API_AUTH",
  security: bearer,
  request: {
    params: VoiceAccountParams,
    body: { content: { 'application/json': { schema: VoiceCredentialsBody } } },
  },
  responses: {
    200: ok(VoiceCredentialsSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/voice-api/webhook',
  tags: adminTags,
  summary:
    "Register the account's own result webhook with its Cell24x7 login (one URL per token; superadmin)",
  security: bearer,
  request: { params: VoiceAccountParams },
  responses: {
    200: ok(VoiceCredentialsSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/voice-api/status',
  tags: adminTags,
  summary: 'Cell24x7 status: token set, webhook registered, last result and error (superadmin)',
  security: bearer,
  responses: { 200: ok(VoiceStatusSchema), 403: errors[403] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/voice-api/webhook',
  tags: adminTags,
  summary: "Register this server's result webhook with Cell24x7 (superadmin)",
  security: bearer,
  responses: {
    200: ok(z.object({ registered: z.boolean(), matches: z.boolean() })),
    403: errors[403],
    409: errors[409],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/voice-api/ivrs',
  tags: adminTags,
  summary: "Every IVR on the platform's Cell24x7 account (superadmin)",
  security: bearer,
  responses: { 200: ok(z.array(AdminVoiceIvrSchema)), 403: errors[403] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/campaigns/{id}/voice-batches/{no}/resolve',
  tags: adminTags,
  summary: 'Decide an uncertain Cell24x7 submit: it reached Cell24x7, or it did not (superadmin)',
  security: bearer,
  request: {
    params: VoiceBatchParams,
    body: { content: { 'application/json': { schema: ResolveVoiceBatchBody } } },
  },
  responses: {
    200: ok(z.object({ batchNo: z.number().int(), state: z.string() })),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/voice-api/ivrs',
  tags,
  summary: 'IVR menus this account may use in a recorded-voice campaign',
  security: bearer,
  responses: { 200: ok(z.array(VoiceIvrSchema)), 403: errors[403] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks/voice-api/a/{account}/{key}',
  tags,
  summary:
    "Cell24x7 call results from an account's own login (secret path per account; answered at once)",
  request: {
    params: AccountVoiceWebhookParams,
    body: { content: { 'application/json': { schema: VoiceWebhookBody } } },
  },
  responses: { 200: ok(z.object({ received: z.boolean() })), 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks/voice-api/{secret}',
  tags,
  summary: 'Cell24x7 call results (secret path; answered at once, processed in the background)',
  request: {
    params: VoiceWebhookParams,
    body: { content: { 'application/json': { schema: VoiceWebhookBody } } },
  },
  responses: { 200: ok(z.object({ received: z.boolean() })), 404: errors[404] },
});
