import { WHATSAPP_LIMITS } from '../../config/limits';
import { META_EVENT_STATUSES } from '../../db/models/meta-webhook-event.model';
import {
  CONNECT_STEPS,
  META_PAYERS,
  REGISTRATION_STATUSES,
  CREDIT_LINE_STATUSES,
  SYNC_STATUSES,
  WA_CHANNEL_STATUSES,
  WA_LIMIT_TIERS,
  WA_MODES,
  WA_PROVIDERS,
  WA_QUALITY,
} from '../../db/models/whatsapp-channel.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

import {
  AdminDisconnectBody,
  ChannelParams,
  EmbeddedSignupBody,
  EventParams,
  ListChannelsQuery,
  ListEventsQuery,
  ManualConnectBody,
  RegisterPinBody,
  RenameChannelBody,
  SimulatorBody,
  WhatsAppBillingBody,
} from './whatsapp.schema';

const iso = z.string().nullable();
const s = z.string().nullable();

export const WhatsAppChannelSchema = registry.register(
  'WhatsAppChannel',
  z.object({
    id: z.string(),
    label: z.string(),
    provider: z.enum(WA_PROVIDERS),
    mode: z.enum(WA_MODES),
    status: z.enum(WA_CHANNEL_STATUSES),
    statusReason: z
      .object({ code: z.string(), message: z.string(), step: z.enum(CONNECT_STEPS).nullable() })
      .nullable()
      .openapi({
        description: 'Why the number needs attention; `step` = where Retry setup resumes',
      }),
    wabaId: z.string(),
    wabaName: s,
    businessName: s,
    phoneNumberId: s,
    displayPhoneNumber: s,
    phoneE164: s,
    verifiedName: s,
    nameStatus: s,
    newNameStatus: s,
    qualityRating: z.enum(WA_QUALITY),
    messagingLimitTier: z.enum(WA_LIMIT_TIERS).nullable(),
    isOnBizApp: z
      .boolean()
      .openapi({ description: 'WhatsApp Business app number (coexistence) — no calling' }),
    billing: z.object({
      metaPayer: z.enum(META_PAYERS),
      creditLine: z.object({ status: z.enum(CREDIT_LINE_STATUSES) }),
      paymentMethodOk: z.boolean().nullable(),
    }),
    coexistence: z
      .object({
        contactsSync: z.enum(SYNC_STATUSES),
        historySync: z.enum(SYNC_STATUSES),
        historyProgress: z.number().nullable(),
        echoesAt: iso,
      })
      .nullable(),
    registration: z.object({ status: z.enum(REGISTRATION_STATUSES) }),
    subscription: z.object({ status: z.enum(['subscribed', 'failed']).nullable() }),
    restriction: z.object({ type: z.string(), until: iso }).nullable(),
    webhook: z.object({ lastEventAt: iso, lastField: s }),
    connectedBy: s,
    connectedAt: iso,
    syncedAt: iso,
    disconnectedAt: iso,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const WhatsAppChannelDetailSchema = registry.register(
  'WhatsAppChannelDetail',
  WhatsAppChannelSchema.extend({
    businessId: s,
    wabaCurrency: s,
    wabaTimezoneId: s,
    wabaReviewStatus: s,
    businessVerificationStatus: s,
    throughputLevel: s,
    accountMode: s,
    platformType: s,
    codeVerificationStatus: s,
    phoneStatus: s,
    isOfficialBusinessAccount: z.boolean(),
    tokenCheckedAt: iso,
    tokenExpiresAt: iso,
    capabilities: z.record(z.string(), z.unknown()).nullable(),
    disconnectedBy: s,
    events24h: z.object({
      total: z.number().int(),
      byField: z.record(z.string(), z.number().int()),
    }),
    history: z.array(
      z.object({ status: z.enum(WA_CHANNEL_STATUSES), reason: s, at: z.string(), by: s }),
    ),
  }),
);

const outcome = z.enum(['connected', 'action_needed', 'needs_reconnect']);

export const WhatsAppConnectResultSchema = registry.register(
  'WhatsAppConnectResult',
  z.object({ channel: WhatsAppChannelSchema, outcome, reconnected: z.boolean() }),
);
const ChannelOutcomeSchema = z.object({ channel: WhatsAppChannelSchema, outcome });

export const WhatsAppConfigSchema = registry.register(
  'WhatsAppConfig',
  z.object({
    enabled: z.boolean(),
    provider: z.enum(['fake', 'meta']),
    appId: s.openapi({ description: 'Meta app id (meta provider only; public)' }),
    configId: s.openapi({ description: 'Embedded Signup configuration id (meta provider only)' }),
    graphVersion: z.string(),
  }),
);

export const WhatsAppChannelListSchema = registry.register(
  'WhatsAppChannelList',
  z.object({
    items: z.array(WhatsAppChannelSchema),
    counts: z.record(z.string(), z.number().int()),
    limit: z.number().int(),
  }),
);

const tags = ['WhatsApp'];
const base = '/api/v1/whatsapp';
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const notSetUp = {
  503: { description: "WhatsApp isn't set up on this server (WHATSAPP_NOT_CONFIGURED)" },
};
const common = { 401: errors[401], 403: errors[403], 404: errors[404], ...notSetUp };
const writes = {
  ...common,
  409: errors[409],
  422: errors[422],
  429: errors[429],
  502: { description: 'Meta returned an error (META_API_ERROR)' },
};

registry.registerPath({
  method: 'get',
  path: `${base}/config`,
  tags,
  summary: 'Embedded Signup config for the browser (any signed-in user; no secrets)',
  security: bearer,
  responses: { 200: ok(WhatsAppConfigSchema), 401: errors[401], ...notSetUp },
});
registry.registerPath({
  method: 'get',
  path: `${base}/channels`,
  tags,
  summary: 'WhatsApp numbers of the account with counts by status (whatsapp.read)',
  security: bearer,
  request: { query: ListChannelsQuery },
  responses: { 200: ok(WhatsAppChannelListSchema), ...common },
});
registry.registerPath({
  method: 'post',
  path: `${base}/channels/embedded-signup`,
  tags,
  summary: `Connect a number from Embedded Signup (whatsapp.manage; ${String(WHATSAPP_LIMITS.connectPerHourPerAccount)} / hour / account)`,
  description:
    'The code is exchanged for the business token on the server; WABA / phone ids from the browser are hints checked against the token. A setup step that fails saves the number as `action_needed`.',
  security: bearer,
  request: json(EmbeddedSignupBody),
  responses: {
    200: ok(WhatsAppConnectResultSchema),
    ...writes,
    422: { description: 'Signup failed (WHATSAPP_SIGNUP_FAILED, details: step) or validation' },
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/channels/{id}`,
  tags,
  summary: 'Number details: ids, Meta statuses, webhook health (24 h), history (whatsapp.read)',
  security: bearer,
  request: { params: ChannelParams },
  responses: { 200: ok(WhatsAppChannelDetailSchema), ...common },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/channels/{id}`,
  tags,
  summary: 'Rename (whatsapp.manage)',
  security: bearer,
  request: { params: ChannelParams, ...json(RenameChannelBody) },
  responses: { 200: ok(WhatsAppChannelSchema), ...writes },
});
for (const [path, summary, body] of [
  ['sync', 'Sync now — token check + Meta details (whatsapp.manage; 1 / min / number)', null],
  ['retry-setup', 'Retry setup from the failed step (whatsapp.manage)', null],
  [
    'register',
    'Finish registration with the number’s two-step PIN (whatsapp.manage)',
    RegisterPinBody,
  ],
  [
    'coexistence-sync',
    'Ask Meta again for the Business app contacts / history (whatsapp.manage)',
    null,
  ],
] as const) {
  registry.registerPath({
    method: 'post',
    path: `${base}/channels/{id}/${path}`,
    tags,
    summary,
    security: bearer,
    request: { params: ChannelParams, ...(body ? json(body) : {}) },
    responses: {
      200: ok(
        path === 'coexistence-sync'
          ? z.object({ channel: WhatsAppChannelSchema })
          : ChannelOutcomeSchema,
      ),
      ...writes,
    },
  });
}
registry.registerPath({
  method: 'post',
  path: `${base}/channels/{id}/disconnect`,
  tags,
  summary: 'Disconnect (whatsapp.manage) — never deregisters the number at Meta',
  security: bearer,
  request: { params: ChannelParams },
  responses: { 200: ok(WhatsAppChannelSchema), ...writes },
});

// ── Meta-facing (public) ────────────────────────────────────────────────────
const metaTags = ['Meta callbacks'];
registry.registerPath({
  method: 'get',
  path: '/api/v1/webhooks/meta',
  tags: metaTags,
  summary: 'Meta webhook verification (hub.mode, hub.verify_token, hub.challenge)',
  request: {
    query: z.object({
      'hub.mode': z.string(),
      'hub.verify_token': z.string(),
      'hub.challenge': z.string(),
    }),
  },
  responses: {
    200: {
      description: 'The challenge (text/plain)',
      content: { 'text/plain': { schema: z.string() } },
    },
    403: { description: 'Wrong mode or token' },
  },
});
export const WebhookReceiptSchema = registry.register(
  'MetaWebhookReceipt',
  z.object({ received: z.number().int(), duplicates: z.number().int(), ignored: z.boolean() }),
);
registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks/meta',
  tags: metaTags,
  summary: 'Meta webhook events (X-Hub-Signature-256 over the raw body, ≤ 3 MB)',
  request: {
    headers: z.object({ 'x-hub-signature-256': z.string().openapi({ example: 'sha256=…' }) }),
    body: {
      content: {
        'application/json': {
          schema: z.object({ object: z.string(), entry: z.array(z.unknown()) }),
        },
      },
    },
  },
  responses: {
    200: ok(WebhookReceiptSchema),
    401: { description: 'Bad / missing signature (META_SIGNATURE_INVALID)' },
    413: errors[413],
    422: errors[422],
    503: { description: 'Storage / queue unavailable — Meta retries (PROVIDER_UNAVAILABLE)' },
  },
});
const signedRequest = {
  body: {
    content: {
      'application/x-www-form-urlencoded': { schema: z.object({ signed_request: z.string() }) },
    },
  },
};
registry.registerPath({
  method: 'post',
  path: '/api/v1/meta/deauthorize',
  tags: metaTags,
  summary: 'Meta deauthorize callback (signed_request) → that user’s numbers need a reconnect',
  request: signedRequest,
  responses: {
    200: ok(z.object({ channels: z.number().int() })),
    401: { description: 'Bad signature (META_SIGNATURE_INVALID)' },
    422: errors[422],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/meta/data-deletion',
  tags: metaTags,
  summary: 'Meta data deletion callback (signed_request) — answers Meta’s exact shape',
  request: signedRequest,
  responses: {
    200: {
      description: 'Status page URL + confirmation code (no envelope)',
      content: {
        'application/json': {
          schema: z.object({ url: z.string(), confirmation_code: z.string() }),
        },
      },
    },
    401: { description: 'Bad signature (META_SIGNATURE_INVALID)' },
    422: errors[422],
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/meta/data-deletion/{code}',
  tags: metaTags,
  summary: 'Data deletion status (public)',
  request: { params: z.object({ code: z.string() }) },
  responses: {
    200: ok(
      z.object({
        status: z.enum(['received', 'completed']),
        receivedAt: z.string(),
        completedAt: iso,
      }),
    ),
    404: errors[404],
  },
});

// ── superadmin ──────────────────────────────────────────────────────────────
const adminTags = ['Superadmin'];
const admin = { 401: errors[401], 403: errors[403], ...notSetUp };
export const WhatsAppAdminStatusSchema = registry.register(
  'WhatsAppAdminStatus',
  z.object({
    enabled: z.boolean(),
    provider: z.enum(['fake', 'meta']),
    graphVersion: z.string(),
    configured: z.object({
      appId: z.boolean(),
      appSecret: z.boolean(),
      configId: z.boolean(),
      verifyToken: z.boolean(),
      creditLine: z.boolean(),
      systemUserToken: z.boolean(),
    }),
    webhookUrl: z.string(),
    deauthorizeUrl: z.string(),
    dataDeletionUrl: z.string(),
    lastEventAt: iso,
    channelsByStatus: z.record(z.string(), z.number().int()),
    eventsByStatus24h: z.record(z.string(), z.number().int()),
  }),
);
export const MetaWebhookEventRowSchema = registry.register(
  'MetaWebhookEventRow',
  z.object({
    id: z.string(),
    field: z.string(),
    status: z.enum(META_EVENT_STATUSES),
    attempts: z.number().int(),
    error: s,
    wabaId: s,
    phoneNumberId: s,
    accountId: s,
    channelId: s,
    receivedAt: z.string(),
    processedAt: iso,
  }),
);
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/whatsapp/status',
  tags: adminTags,
  summary: 'WhatsApp setup status: provider, configured flags (booleans), webhook URL, counts',
  security: bearer,
  responses: { 200: ok(WhatsAppAdminStatusSchema), ...admin },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/whatsapp/events',
  tags: adminTags,
  summary: 'Meta webhook events — metadata only (never payloads)',
  security: bearer,
  request: { query: ListEventsQuery },
  responses: { 200: ok(z.array(MetaWebhookEventRowSchema)), ...admin, 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp/events/{id}/replay',
  tags: adminTags,
  summary: 'Replay a failed / ignored event (audited)',
  security: bearer,
  request: { params: EventParams },
  responses: {
    200: ok(z.object({ id: z.string(), status: z.literal('received') })),
    ...admin,
    404: errors[404],
    409: errors[409],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp/channels/{id}/disconnect',
  tags: adminTags,
  summary: 'Force disconnect with a reason (owners notified, audited in both accounts)',
  security: bearer,
  request: { params: ChannelParams, ...json(AdminDisconnectBody) },
  responses: { 200: ok(WhatsAppChannelSchema), ...admin, 404: errors[404], 422: errors[422] },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/whatsapp-billing',
  tags: adminTags,
  summary:
    'Who pays Meta for numbers connected from now on (a credit line can’t be removed later) and the account WhatsApp price override: markup, fixed prices, platform fee (Phase 11)',
  security: bearer,
  request: { params: ChannelParams, ...json(WhatsAppBillingBody) },
  responses: {
    200: ok(
      z.object({
        metaPayer: z.enum(META_PAYERS),
        whatsappBilling: z.object({
          markupBps: z.number().nullable(),
          fixedPrices: z
            .object({
              marketing: z.number().optional(),
              utility: z.number().optional(),
              authentication: z.number().optional(),
              service: z.number().optional(),
            })
            .nullable(),
          platformFeeMicros: z.number().nullable(),
        }),
      }),
    ),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/whatsapp/manual-connect',
  tags: adminTags,
  summary: 'Connect a number with a System User token (platform test number)',
  security: bearer,
  request: { params: ChannelParams, ...json(ManualConnectBody) },
  responses: {
    200: ok(WhatsAppConnectResultSchema),
    ...admin,
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

// ── dev ─────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/api/v1/dev/meta/webhooks',
  tags: ['Dev'],
  summary:
    'DEV ONLY — simulate a Meta webhook event for a number (not in production; MOCK_APIS_ENABLED)',
  security: bearer,
  request: json(SimulatorBody),
  responses: {
    200: ok(WebhookReceiptSchema.extend({ kind: z.string(), field: z.string() })),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});
