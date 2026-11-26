import { WHATSAPP_LIMITS } from '../../config/limits';
import { META_EVENT_STATUSES } from '../../db/models/meta-webhook-event.model';
import {
  CONNECT_STEPS,
  META_CALLING_METHODS,
  META_CALLING_STATUSES,
  META_PAYERS,
  REGISTRATION_STATUSES,
  CREDIT_LINE_STATUSES,
  SYNC_STATUSES,
  WA_CALLING_STATUSES,
  WA_CALLING_UNAVAILABLE_REASONS,
  WA_CHANNEL_STATUSES,
  WA_LIMIT_TIERS,
  WA_WEBHOOK_STATUSES,
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
  ConfirmCreditLineBody,
  EmbeddedSignupBody,
  EventParams,
  ListChannelsQuery,
  ListEventsQuery,
  ListMetaCallErrorsQuery,
  ManagedCreditLineBody,
  ManagedKeyBody,
  ManagedNumberBody,
  ManualConnectBody,
  MetaCallingBody,
  MetaCallingOffBody,
  PartnerKeyRevealBody,
  PartnerTryBody,
  RegisterPinBody,
  RenameChannelBody,
  SeedManagedNumberBody,
  SimulatedUserCallBody,
  SimulatorBody,
  SwitchToMetaBody,
  WhatsAppBillingBody,
  WhatsAppSolutionIdBody,
} from './whatsapp.schema';

const iso = z.string().nullable();
const s = z.string().nullable();

/** SAC-T4: does Meta deliver this number's events (messages, calls) to us? */
export const WebhookCheckSchema = z.object({
  status: z.enum(WA_WEBHOOK_STATUSES),
  appSubscribed: z.boolean().nullable(),
  missingFields: z.array(z.string()),
  checkedAt: z.string().nullable(),
  fixedAt: z.string().nullable(),
  error: z.string().nullable(),
});
const WebhookStepSchema = z.object({
  key: z.enum(['app_subscribed', 'fields', 'fix_app', 'fix_fields']),
  ok: z.boolean(),
  detail: z.string().nullable(),
});

/** PMC: calls of a managed number over Meta Graph with our app's token (never the token). */
export const MetaCallingSchema = registry.register(
  'WhatsAppMetaCalling',
  z.object({
    status: z.enum(META_CALLING_STATUSES).openapi({
      description: '`on` = calls go over Meta Graph; messages stay on the partner',
    }),
    method: z.enum(META_CALLING_METHODS).nullable(),
    tokenLast4: s,
    tokenExpiresAt: iso,
    webhookCheck: WebhookCheckSchema,
    enabledAt: iso,
    checkedAt: iso,
    error: z.object({ code: z.string(), step: s, message: z.string() }).nullable(),
  }),
);

export const WhatsAppChannelSchema = registry.register(
  'WhatsAppChannel',
  z.object({
    id: z.string(),
    label: z.string(),
    provider: z.enum(WA_PROVIDERS),
    managed: z.boolean().openapi({
      description:
        'A managed number: every call goes through the partner API (Pinnacle); added and looked after by the platform team',
    }),
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
    messageClassificationKnown: z.boolean().optional(),
    messageRateLimit: z.number().optional().openapi({
      description: 'Application send cap per second, including any lower deployment ceiling',
    }),
    isOnBizApp: z
      .boolean()
      .openapi({ description: 'WhatsApp Business app number (coexistence) — no calling' }),
    calling: z.object({
      status: z.enum(WA_CALLING_STATUSES),
      unavailableReason: z.enum(WA_CALLING_UNAVAILABLE_REASONS).nullable(),
      restricted: z.boolean().openapi({ description: 'Meta paused calling on the number now' }),
    }),
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
    canRegister: z.boolean(),
    subscription: z.object({ status: z.enum(['subscribed', 'failed']).nullable() }),
    restriction: z.object({ type: z.string(), until: iso }).nullable(),
    webhook: z.object({ lastEventAt: iso, lastField: s }),
    webhookCheck: WebhookCheckSchema,
    metaCalling: MetaCallingSchema,
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
    metaPayer: z.enum(META_PAYERS),
    solutionId: s.openapi({
      description: 'Partner Solution id for this platform-payer account; null otherwise',
    }),
    metaCallingEnabled: z.boolean().openapi({
      description: 'PMC: "Calling on karo (Meta direct)" is offered on managed numbers',
    }),
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
registry.registerPath({
  method: 'post',
  path: `${base}/channels/{id}/switch-to-meta`,
  tags,
  summary:
    'SAC-T11: switch a managed (partner) number to Meta direct — our Embedded Signup for the same WABA and number; same channel id, the partner credit line keeps paying (whatsapp.manage)',
  security: bearer,
  request: { params: ChannelParams, ...json(SwitchToMetaBody) },
  responses: {
    200: ok(
      z.object({
        channel: WhatsAppChannelSchema,
        outcome: z.string(),
        partnerWebhookCleared: z.boolean(),
      }),
    ),
    ...writes,
    422: errors[422],
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/channels/{id}/webhook`,
  tags,
  summary: "SAC-T4: the last check that Meta delivers this number's events to us (whatsapp.read)",
  security: bearer,
  request: { params: ChannelParams },
  responses: {
    200: ok(z.object({ provider: z.enum(['meta', 'pinnacle']), webhookCheck: WebhookCheckSchema })),
    ...common,
  },
});
registry.registerPath({
  method: 'post',
  path: `${base}/channels/{id}/webhook/fix`,
  tags,
  summary:
    'SAC-T4: Webhook check / Fix — subscribe our app to the WABA, add missing app webhook fields, check again (whatsapp.manage; 6 / 10 min / number)',
  security: bearer,
  request: { params: ChannelParams },
  responses: {
    200: ok(z.object({ webhookCheck: WebhookCheckSchema, steps: z.array(WebhookStepSchema) })),
    ...writes,
  },
});
// PMC: calls of a managed number over Meta Graph
const MetaCallingStepSchema = z.object({
  key: z.enum(['token', 'verify', 'app_subscribed', 'fields', 'calling_on']),
  ok: z.boolean(),
  detail: z.string().nullable(),
});
const MetaCallingResultSchema = z.object({
  channel: WhatsAppChannelSchema,
  steps: z.array(MetaCallingStepSchema),
});
const MetaCallingOffResultSchema = z.object({
  channel: WhatsAppChannelSchema,
  turnedOffAtWhatsApp: z.boolean(),
  unsubscribed: z
    .boolean()
    .openapi({ description: 'Our app left the WABA (no other number of ours uses it)' }),
});
registry.registerPath({
  method: 'get',
  path: `${base}/channels/{id}/meta-calling`,
  tags,
  summary:
    "PMC: a managed number's calls over Meta Graph — the last state, never the token (whatsapp.read)",
  security: bearer,
  request: { params: ChannelParams },
  responses: { 200: ok(MetaCallingSchema), ...common },
});
registry.registerPath({
  method: 'post',
  path: `${base}/channels/{id}/meta-calling`,
  tags,
  summary:
    'PMC: Calling on (Meta direct) — Embedded Signup code for the same WABA / number (a System User token only from a superadmin in full access); subscribes our app + `calls`, turns calling on at WhatsApp. Messages stay on the partner (whatsapp.manage; 6 / 10 min / number)',
  security: bearer,
  request: {
    params: ChannelParams,
    body: { content: { 'application/json': { schema: MetaCallingBody } } },
  },
  responses: { 200: ok(MetaCallingResultSchema), ...writes },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/channels/{id}/meta-calling`,
  tags,
  summary:
    'PMC: Calling off (Meta direct) — token removed, our app leaves the WABA when unused, calls back to the partner (whatsapp.manage)',
  security: bearer,
  request: {
    params: ChannelParams,
    body: { content: { 'application/json': { schema: MetaCallingOffBody } } },
  },
  responses: { 200: ok(MetaCallingOffResultSchema), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/channels/{id}/meta-calling/check`,
  tags,
  summary:
    'PMC: Check / Fix — token, WABA / number access, our app + `calls` webhook (repaired), call settings (whatsapp.manage; 6 / 10 min / number)',
  security: bearer,
  request: { params: ChannelParams },
  responses: { 200: ok(MetaCallingResultSchema), ...writes },
});
for (const [path, summary, body] of [
  ['sync', 'Sync now — token check + Meta details (whatsapp.manage; 1 / min / number)', null],
  ['retry-setup', 'Retry setup from the failed step (whatsapp.manage)', null],
  [
    'register',
    'Register the number on the Cloud API — PIN optional, the configured one is used without it (whatsapp.manage)',
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
registry.registerPath({
  method: 'get',
  path: '/api/v1/webhooks/pinnacle/{channelId}',
  tags: metaTags,
  summary: 'Partner (Pinnacle) webhook ping — answers ok, reads nothing',
  request: { params: z.object({ channelId: z.string() }) },
  responses: {
    200: { description: '`ok` (text/plain)', content: { 'text/plain': { schema: z.string() } } },
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/webhooks/pinnacle/{channelId}',
  tags: metaTags,
  summary:
    "Meta's webhook payload relayed by Pinnacle for one managed number (x-cell-webhook-secret, ≤ 3 MB)",
  request: {
    params: z.object({ channelId: z.string() }),
    headers: z.object({
      'x-cell-webhook-secret': z
        .string()
        .openapi({ description: 'The per-number secret we gave the partner (setwebhook)' }),
    }),
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
    403: { description: 'Missing / wrong secret (PINNACLE_WEBHOOK_FORBIDDEN)' },
    404: errors[404],
    413: errors[413],
    422: errors[422],
    503: {
      description: 'Storage / queue unavailable — the partner retries (PROVIDER_UNAVAILABLE)',
    },
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
      solutionIdConfigured: z.boolean(),
      verifyToken: z.boolean(),
      creditLine: z.boolean(),
      systemUserToken: z.boolean(),
    }),
    webhookUrl: z.string(),
    deauthorizeUrl: z.string(),
    dataDeletionUrl: z.string(),
    lastEventAt: iso,
    pinnacle: z.object({
      enabled: z.boolean(),
      baseUrl: z.string(),
      voiceBaseUrl: z.string(),
    }),
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
  method: 'patch',
  path: '/api/v1/admin/whatsapp/solution-id',
  tags: adminTags,
  summary: 'Set or clear the platform Partner Solution id (value is never returned)',
  security: bearer,
  request: { ...json(WhatsAppSolutionIdBody) },
  responses: {
    200: ok(z.object({ solutionIdConfigured: z.boolean() })),
    ...admin,
    422: errors[422],
  },
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
export const MetaCallErrorRowSchema = registry.register(
  'AdminMetaCallError',
  z.object({
    id: z.string(),
    accountId: z.string(),
    accountName: z.string(),
    channelId: z.string(),
    numberLast4: z.string(),
    callId: z.string().nullable(),
    op: z.string(),
    metaCode: z.number().nullable(),
    metaSubcode: z.number().nullable(),
    type: z.string().nullable(),
    message: z.string(),
    fbtraceId: z.string().nullable(),
    httpStatus: z.number().nullable(),
    via: z.enum(['meta', 'meta_direct', 'pinnacle']),
    at: z.string(),
  }),
);
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/whatsapp/meta-call-errors',
  tags: adminTags,
  summary: 'Recent, masked Meta calling errors across accounts (superadmin only)',
  security: bearer,
  request: { query: ListMetaCallErrorsQuery },
  responses: { 200: ok(z.array(MetaCallErrorRowSchema)), ...admin, 422: errors[422] },
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
        /** Phase 12: the account's call price override. */
        whatsappCallingBilling: z.object({
          markupBps: z.number().nullable(),
          fixedPerMinuteMicros: z.number().nullable(),
          platformFeePerMinuteMicros: z.number().nullable(),
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

// PN: managed numbers over the Pinnacle partner API
const partnerFailed = {
  description:
    "The partner refused the request or didn't keep our webhook (WA_PROVIDER_ERROR / PINNACLE_WEBHOOK_NOT_SET)",
};
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/whatsapp/managed-numbers',
  tags: adminTags,
  summary:
    'Add a managed number (lives at Pinnacle): key checked, details read, our webhook set at the partner',
  security: bearer,
  request: { params: ChannelParams, ...json(ManagedNumberBody) },
  responses: {
    201: ok(ChannelOutcomeSchema),
    ...admin,
    404: errors[404],
    409: errors[409],
    422: errors[422],
    502: partnerFailed,
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp/channels/{id}/managed/api-key',
  tags: adminTags,
  summary: 'Replace the partner API key of a managed number (checked; webhook set with it)',
  security: bearer,
  request: { params: ChannelParams, ...json(ManagedKeyBody) },
  responses: {
    200: ok(WhatsAppChannelSchema),
    ...admin,
    404: errors[404],
    409: errors[409],
    422: errors[422],
    502: partnerFailed,
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp/channels/{id}/webhook/fix',
  tags: adminTags,
  summary: "SAC-T4: Webhook check / Fix of any account's Meta number (superadmin, audited)",
  security: bearer,
  request: { params: ChannelParams },
  responses: {
    200: ok(z.object({ webhookCheck: WebhookCheckSchema, steps: z.array(WebhookStepSchema) })),
    ...admin,
    404: errors[404],
    409: errors[409],
  },
});
for (const [method, path, summary, schema, body] of [
  [
    'post',
    '/api/v1/admin/whatsapp/channels/{id}/meta-calling',
    "PMC: Calling on (Meta direct) for any account's managed number — code or System User token (superadmin, audited)",
    MetaCallingResultSchema,
    MetaCallingBody,
  ],
  [
    'delete',
    '/api/v1/admin/whatsapp/channels/{id}/meta-calling',
    "PMC: Calling off (Meta direct) for any account's managed number (superadmin, audited)",
    MetaCallingOffResultSchema,
    MetaCallingOffBody,
  ],
  [
    'post',
    '/api/v1/admin/whatsapp/channels/{id}/meta-calling/check',
    "PMC: Check / Fix of any account's Meta calling (superadmin, audited)",
    MetaCallingResultSchema,
    null,
  ],
] as const) {
  registry.registerPath({
    method,
    path,
    tags: adminTags,
    summary,
    security: bearer,
    request: {
      params: ChannelParams,
      ...(body ? { body: { content: { 'application/json': { schema: body } } } } : {}),
    },
    responses: {
      200: ok(schema),
      ...admin,
      404: errors[404],
      409: errors[409],
      422: errors[422],
      429: errors[429],
    },
  });
}
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp/channels/{id}/managed/webhook',
  tags: adminTags,
  summary: 'Set our webhook again at the partner with a new secret (read back)',
  security: bearer,
  request: { params: ChannelParams },
  responses: {
    200: ok(WhatsAppChannelSchema),
    ...admin,
    404: errors[404],
    409: errors[409],
    502: partnerFailed,
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp/channels/{id}/managed/credit-line',
  tags: adminTags,
  summary:
    'The partner credit line of a managed number: requested (number waits) or active (as approved in the partner panel)',
  security: bearer,
  request: { params: ChannelParams, ...json(ManagedCreditLineBody) },
  responses: {
    200: ok(WhatsAppChannelSchema),
    ...admin,
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp/channels/{id}/credit-line/confirm',
  tags: adminTags,
  summary: 'Record a superadmin confirmation that the platform credit line is attached in Meta',
  security: bearer,
  request: { params: ChannelParams, ...json(ConfirmCreditLineBody) },
  responses: {
    200: ok(WhatsAppChannelSchema),
    ...admin,
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

// ── dev ─────────────────────────────────────────────────────────────────────
registry.registerPath({
  method: 'post',
  path: '/api/v1/dev/meta/managed-number',
  tags: ['Dev'],
  summary:
    'DEV ONLY — a fake number "at Pinnacle" and its test API key, to try Add managed number (superadmin; fake provider)',
  security: bearer,
  request: json(SeedManagedNumberBody),
  responses: {
    200: ok(
      z.object({
        apiKey: z.string(),
        wabaId: z.string(),
        phoneNumberId: z.string(),
        displayPhoneNumber: z.string().nullable(),
      }),
    ),
    401: errors[401],
    403: errors[403],
    503: { description: 'Managed numbers are off (WA_PROVIDER_NOT_CONFIGURED)' },
  },
});
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

registry.registerPath({
  method: 'post',
  path: '/api/v1/dev/meta/calls/user-call',
  tags: ['Dev'],
  summary:
    'DEV ONLY — the fake customer calls the WhatsApp number (the inbound call flow runs for real)',
  security: bearer,
  request: json(SimulatedUserCallBody),
  responses: {
    200: ok(z.object({ kind: z.literal('user_call'), waCallId: z.string() })),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/dev/meta/calls',
  tags: ['Dev'],
  summary:
    "DEV ONLY — the fake customer's side of each WhatsApp call on a number (heard tone / level, keys sent, duration; no SDP)",
  security: bearer,
  request: { query: z.object({ channelId: z.string() }) },
  responses: {
    200: ok(
      z.object({
        calls: z.array(
          z.object({
            waCallId: z.string(),
            phoneNumberId: z.string(),
            toLast4: z.string(),
            direction: z.enum(['BUSINESS_INITIATED', 'USER_INITIATED']),
            state: z.enum(['ringing', 'accepted', 'ended']),
            endStatus: z.enum(['COMPLETED', 'FAILED']).nullable(),
            durationSec: z.number().nullable(),
            heardTone: z.boolean(),
            heardLevel: z.number().nullable(),
            dtmfSent: z.string(),
            connected: z.boolean(),
          }),
        ),
      }),
    ),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});

// ── PIN: Pinnacle partner API reference (superadmins only; never in the public spec) ──
const PartnerEndpointSchema = z.object({
  id: z.string(),
  group: z.string(),
  method: z.enum(['GET', 'POST', 'DELETE']),
  path: z.string(),
  host: z.enum(['base', 'voice']),
  summary: z.string(),
  body: z.record(z.string(), z.unknown()).optional(),
  response: z.unknown().optional(),
  notes: z.string().optional(),
  supported: z.boolean(),
  tryIt: z.boolean(),
});
const PartnerApiInfoSchema = registry.register(
  'PartnerApiInfo',
  z.object({
    configured: z.boolean(),
    baseUrl: z.string(),
    voiceBaseUrl: z.string(),
    authHeader: z.string(),
    errorFormat: z.object({ example: z.record(z.string(), z.unknown()), note: z.string() }),
    numbers: z.array(
      z.object({
        channelId: z.string(),
        label: z.string(),
        status: z.string(),
        wabaId: z.string(),
        phoneNumberId: z.string().nullable(),
        displayPhoneNumber: z.string().nullable(),
        keyConfigured: z.boolean(),
        keyLast4: z.string().nullable(),
        keyCheckedAt: z.string().nullable(),
        webhook: z.object({
          url: z.string(),
          headerName: z.string(),
          setAt: z.string().nullable(),
        }),
      }),
    ),
    groups: z.array(z.string()),
    endpoints: z.array(PartnerEndpointSchema),
  }),
);
const PartnerRevealSchema = z.object({
  apiKey: z.string(),
  keyLast4: z.string(),
  expiresInSec: z.number(),
});
const PartnerTrySchema = z.object({
  endpointId: z.string(),
  ok: z.boolean(),
  httpStatus: z.number(),
  durationMs: z.number(),
  body: z.unknown(),
});
const partnerErrors = {
  401: errors[401],
  403: errors[403],
  404: errors[404],
  409: errors[409],
  422: errors[422],
  429: errors[429],
};
for (const [prefix, who, tagList] of [
  ['/api/v1/admin', 'superadmin', adminTags],
  ['/api/v1', 'superadmin in a full-access login-as', tags],
] as const) {
  registry.registerPath({
    method: 'get',
    path:
      prefix === '/api/v1/admin'
        ? `${prefix}/accounts/{id}/partner-api`
        : `${prefix}/whatsapp/partner-api`,
    tags: [...tagList],
    summary: `PIN: the Pinnacle partner API reference of the account — base URLs, managed numbers (key last 4), endpoints (${who})`,
    security: bearer,
    ...(prefix === '/api/v1/admin' ? { request: { params: ChannelParams } } : {}),
    responses: { 200: ok(PartnerApiInfoSchema), ...partnerErrors },
  });
  registry.registerPath({
    method: 'post',
    path: `${prefix}/whatsapp/channels/{id}/partner-api/reveal`,
    tags: [...tagList],
    summary: `PIN: reveal a managed number's API key — your own password (+ two-step code); 5 / hour, audited, no-store (${who})`,
    security: bearer,
    request: {
      params: ChannelParams,
      body: { content: { 'application/json': { schema: PartnerKeyRevealBody } } },
    },
    responses: { 200: ok(PartnerRevealSchema), ...partnerErrors },
  });
  registry.registerPath({
    method: 'post',
    path: `${prefix}/whatsapp/channels/{id}/partner-api/try`,
    tags: [...tagList],
    summary: `PIN: run a read-only partner API operation with the number's key (our server only); 20 / 10 min, audited (${who})`,
    security: bearer,
    request: {
      params: ChannelParams,
      body: { content: { 'application/json': { schema: PartnerTryBody } } },
    },
    responses: { 200: ok(PartnerTrySchema), ...partnerErrors },
  });
}
