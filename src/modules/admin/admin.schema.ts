import { PUBLIC_API_LIMITS, ACCOUNT_LIMIT_RANGES } from '../../config/limits';
import { ACCOUNT_VOICE_LINES } from '../../db/models/account.model';
import { META_PAYERS, WA_CHANNEL_STATUSES, WA_MODES } from '../../db/models/whatsapp-channel.model';
import { OffsetPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import {
  ObjectIdSchema,
  PaginationQuerySchema,
  PhoneE164Schema,
} from '../../shared/validation/schemas';
import { AuditEntrySchema } from '../audit/audit.schema';
import {
  AuthSessionSchema,
  EmailSchema,
  PublicAccountSchema,
  PublicUserSchema,
  TimezoneSchema,
} from '../auth/auth.schema';
import { RetentionCapBody, RetentionSchema } from '../retention/retention.schema';

export const ListAccountsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  status: z.enum(['active', 'suspended']).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  /** Phase 19 */
  kind: z.enum(['business', 'reseller']).optional(),
  parentAccountId: ObjectIdSchema.optional(),
});
/** Phase 19: move a business to a reseller, or back to direct (`null`). */
export const SetResellerBody = z.strictObject({ parentAccountId: ObjectIdSchema.nullable() });
export const SignupSettingsBody = z.strictObject({
  open: z.boolean(),
  resellerSignup: z.enum(['open', 'approval', 'closed']),
});

export const AccountIdParams = z.strictObject({ id: ObjectIdSchema });
/** Phase 19: `view` = read-only (today), `act` = may work; sensitive actions refused in both. */
export const ImpersonateBody = z
  .strictObject({ mode: z.enum(['view', 'act']).default('view') })
  .default({ mode: 'view' });

/** A customer account made by a superadmin, whose owner can sign in with this password at once. */
export const CreateAccountBody = z.strictObject({
  businessName: z.string().trim().min(2).max(80).openapi({ example: 'Demo Finance' }),
  ownerName: z.string().trim().min(1).max(80).openapi({ example: 'Asha Verma' }),
  ownerEmail: EmailSchema,
  ownerPassword: z.string().min(1).max(200),
  ownerPhone: PhoneE164Schema.optional(),
  timezone: TimezoneSchema.optional(),
  /** Phase 19: a reseller, or a business (optionally under a reseller). */
  kind: z.enum(['business', 'reseller']).optional(),
  parentAccountId: ObjectIdSchema.optional(),
});
/** A superadmin sets the owner's password; the owner's sessions end. */
export const SetOwnerPasswordBody = z.strictObject({ password: z.string().min(1).max(200) });
/** Requests a minute for this account's API keys; `null` = the default (600 / 60). */
export const ApiLimitsBody = z.strictObject({
  apiLimits: z
    .object({
      readsPerMinute: z.number().int().min(1).max(PUBLIC_API_LIMITS.readsPerMinuteMax),
      writesPerMinute: z.number().int().min(1).max(PUBLIC_API_LIMITS.writesPerMinuteMax),
    })
    .nullable(),
});
/** Phase 18: the account's phone line (superadmin). */
export const VoiceLineBody = z.strictObject({ voiceLine: z.enum(ACCOUNT_VOICE_LINES) });
/** Phase 18: SIP overrides of the env defaults; `null` = the default. */
export const SipSettingsBody = z.strictObject({
  pulseSec: z.number().int().min(1).max(60).nullable(),
  spendMinutesPerHour: z.number().int().min(1).max(100_000).nullable(),
});
export const SuspendBody = z.strictObject({ reason: z.string().trim().min(3).max(200) });
export const AccountCampaignParams = z.strictObject({
  id: ObjectIdSchema,
  campaignId: ObjectIdSchema,
});

const limit = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);

/** Dialing limits of an account (Phase 8, superadmin). */
export const AccountLimitsBody = z
  .strictObject({
    maxConcurrentCalls: limit(ACCOUNT_LIMIT_RANGES.maxConcurrentCalls).optional(),
    dialsPerMinute: limit(ACCOUNT_LIMIT_RANGES.dialsPerMinute).optional(),
  })
  .refine((b) => b.maxConcurrentCalls !== undefined || b.dialsPerMinute !== undefined, {
    message: 'Change at least one limit',
  });

export const AccountLimitsSchema = registry.register(
  'AccountLimits',
  z.object({ maxConcurrentCalls: z.number().int(), dialsPerMinute: z.number().int() }),
);

export const AdminAccountRowSchema = registry.register(
  'AdminAccountRow',
  z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(['active', 'suspended']),
    ownerEmail: z.string().nullable(),
    usersCount: z.number().int(),
    kind: z.enum(['platform', 'reseller', 'business']),
    parent: z.object({ id: z.string(), name: z.string() }).nullable(),
    customersCount: z.number().int().nullable().openapi({ description: 'Resellers only' }),
    resellerStatus: z.enum(['active', 'pending_approval']).nullable(),
    createdAt: z.string(),
  }),
);

export const AdminAccountDetailSchema = registry.register(
  'AdminAccountDetail',
  z.object({
    account: PublicAccountSchema,
    owner: PublicUserSchema.nullable(),
    usersCount: z.number().int(),
    apiLimits: z.object({ readsPerMinute: z.number(), writesPerMinute: z.number() }).nullable(),
    voiceLine: z.enum(ACCOUNT_VOICE_LINES),
    sipSettings: SipSettingsBody,
    voiceApi: z
      .object({
        enabled: z.boolean(),
        ivrIds: z.array(z.number().int()),
        ivrEstimateSec: z.number().int(),
      })
      .openapi({ description: 'VAPI: recorded-voice / IVR campaigns over Cell24x7' }),
    usersByStatus: z.object({ invited: z.number(), active: z.number(), disabled: z.number() }),
    limits: AccountLimitsSchema,
    retention: RetentionSchema,
    activeCampaigns: z.number().int().openapi({ description: 'Scheduled, running or paused' }),
    adminPausedCampaigns: z.array(z.object({ id: z.string(), name: z.string() })).openapi({
      description: 'Paused by the platform team — only a superadmin resumes them (≤ 100)',
    }),
    whatsappBilling: z
      .object({
        metaPayer: z.enum(META_PAYERS),
        markupBps: z.number().int().nullable(),
        fixedPrices: z
          .object({
            marketing: z.number().int().optional(),
            utility: z.number().int().optional(),
            authentication: z.number().int().optional(),
            service: z.number().int().optional(),
          })
          .nullable(),
        platformFeeMicros: z.number().int().nullable(),
      })
      .openapi({
        description:
          'Who pays Meta for WhatsApp numbers connected from now on (Phase 9) and the account price override — null = the global settings (Phase 11)',
      }),
    whatsappChannels: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        status: z.enum(WA_CHANNEL_STATUSES),
        mode: z.enum(WA_MODES),
        displayPhoneNumber: z.string().nullable(),
        verifiedName: z.string().nullable(),
        qualityRating: z.string(),
        messagingLimitTier: z.string().nullable(),
        metaPayer: z.enum(META_PAYERS),
        creditLineStatus: z.string(),
        connectedAt: z.string().nullable(),
      }),
    ),
    recentAudit: z.array(AuditEntrySchema),
  }),
);

const tags = ['Superadmin'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/accounts',
  tags,
  summary: 'All customer accounts (superadmin)',
  security: bearer,
  request: { query: ListAccountsQuery },
  responses: {
    200: {
      description: 'Accounts',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(AdminAccountRowSchema),
            meta: OffsetPageMetaSchema,
          }),
        },
      },
    },
    401: errors[401],
    403: errors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts',
  tags,
  summary: 'Create a customer account with an owner who can sign in at once (superadmin)',
  security: bearer,
  request: json(CreateAccountBody),
  responses: {
    201: ok(PublicAccountSchema),
    401: errors[401],
    403: errors[403],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/owner-password',
  tags,
  summary: "Set the owner's password; the owner's sessions end (superadmin)",
  security: bearer,
  request: { params: AccountIdParams, ...json(SetOwnerPasswordBody) },
  responses: {
    204: noContentResponse,
    401: errors[401],
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/accounts/{id}',
  tags,
  summary: 'Account detail with owner, user counts and recent audit (superadmin)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: { 200: ok(AdminAccountDetailSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/suspend',
  tags,
  summary: 'Suspend an account — it becomes read-only (superadmin)',
  security: bearer,
  request: { params: AccountIdParams, ...json(SuspendBody) },
  responses: { 200: ok(PublicAccountSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/enable',
  tags,
  summary: 'Re-enable a suspended account (superadmin)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: { 200: ok(PublicAccountSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/impersonate',
  tags,
  summary: 'View as the account owner for 30 minutes (no refresh cookie; audited)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: { 200: ok(AuthSessionSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/impersonation/stop',
  tags,
  summary: 'End an impersonation session (call with the impersonation token)',
  security: bearer,
  responses: { 204: noContentResponse, 401: errors[401], 409: errors[409] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/limits',
  tags,
  summary: 'Set the dialing limits of an account (superadmin; audited)',
  security: bearer,
  request: { params: AccountIdParams, ...json(AccountLimitsBody) },
  responses: { 200: ok(AccountLimitsSchema), 403: errors[403], 404: errors[404], 422: errors[422] },
});

export { RetentionCapBody };

registry.registerPath({
  method: 'put',
  path: '/api/v1/admin/accounts/{id}/retention-cap',
  tags,
  summary:
    'Cap how long an account may keep call records and WhatsApp chats (superadmin; null = platform default; audited)',
  security: bearer,
  request: {
    params: AccountIdParams,
    body: { content: { 'application/json': { schema: RetentionCapBody } } },
  },
  responses: { 200: ok(RetentionSchema), 403: errors[403], 404: errors[404], 422: errors[422] },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/campaigns/pause',
  tags,
  summary: 'Emergency pause of every scheduled / running campaign of an account (superadmin)',
  description: 'Paused with reason `admin`: only a superadmin can resume them.',
  security: bearer,
  request: { params: AccountIdParams },
  responses: {
    200: ok(z.object({ paused: z.number().int() })),
    403: errors[403],
    404: errors[404],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/campaigns/{campaignId}/resume',
  tags,
  summary: 'Resume a campaign paused by the platform team (superadmin)',
  security: bearer,
  request: { params: AccountCampaignParams },
  responses: {
    200: ok(z.object({ id: z.string(), status: z.string() })),
    403: errors[403],
    404: errors[404],
    409: errors[409],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/account-deletions',
  tags,
  summary: 'Accounts waiting for deletion, with wallet balance (superadmin)',
  security: bearer,
  responses: {
    200: ok(
      z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.enum(['scheduled', 'purging', 'purged']),
          requestedAt: z.string().nullable(),
          scheduledFor: z.string().nullable(),
          balanceMicros: z.number(),
        }),
      ),
    ),
    401: errors[401],
    403: errors[403],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/deletion/cancel',
  tags,
  summary: 'Cancel a scheduled account deletion (superadmin)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: {
    200: ok(z.object({ canceled: z.literal(true) })),
    403: errors[403],
    404: errors[404],
    409: errors[409],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/deletion/run',
  tags,
  summary: 'Purge an account now, only after its waiting period (superadmin)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: {
    200: ok(z.object({ status: z.enum(['purged', 'waiting']), contacts: z.number() })),
    403: errors[403],
    404: errors[404],
    409: errors[409],
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/voice-line',
  tags,
  summary: 'Move this account to the phone line (sip) or back to the test line (superadmin)',
  security: bearer,
  request: { params: AccountIdParams, ...json(VoiceLineBody) },
  responses: { 200: ok(VoiceLineBody), 403: errors[403], 404: errors[404], 422: errors[422] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/sip-settings',
  tags,
  summary: "Set this account's SIP billing pulse and spend guard; null = default (superadmin)",
  security: bearer,
  request: { params: AccountIdParams, ...json(SipSettingsBody) },
  responses: { 200: ok(SipSettingsBody), 403: errors[403], 404: errors[404], 422: errors[422] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/api-limits',
  tags,
  summary: "Set this account's API key limits per minute; null = default (superadmin)",
  security: bearer,
  request: { params: AccountIdParams, ...json(ApiLimitsBody) },
  responses: { 200: ok(ApiLimitsBody), 403: errors[403], 404: errors[404], 422: errors[422] },
});

const Counts = z.object({
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
});

export const SystemStatusSchema = registry.register(
  'SystemStatus',
  z.object({
    commit: z.string(),
    builtAt: z.string(),
    env: z.string(),
    uptimeSec: z.number().int(),
    mongo: z.object({ ok: z.boolean(), primary: z.boolean(), version: z.string().nullable() }),
    redis: z.object({ ok: z.boolean(), usedMemoryMb: z.number().nullable() }),
    queues: z
      .record(z.string(), Counts)
      .openapi({ description: '-1 when a queue could not be read' }),
    lastBackup: z.object({ at: z.string(), ok: z.boolean(), bytes: z.number() }).nullable(),
    lastRestoreDrill: z.object({ at: z.string(), rtoMinutes: z.number() }).nullable(),
    lastRelease: z
      .object({ at: z.string(), tag: z.string(), backend: z.string(), frontend: z.string() })
      .nullable(),
    certificate: z.object({ daysLeft: z.number().int() }).nullable(),
    superadminsWithoutMfa: z.number().int(),
    sip: z
      .object({
        ariConnected: z.boolean(),
        trunkOnline: z.boolean().nullable(),
        liveChannels: z.number().int(),
        maxChannels: z.number().int(),
        maxCps: z.number().int(),
        causes24h: z.record(z.string(), z.number()),
        avgLossPct: z.number().nullable(),
        avgJitterMs: z.number().nullable(),
      })
      .nullable(),
    whatsappCalls: z
      .object({
        mediaEnabled: z.boolean(),
        publicIpSet: z.boolean(),
        portRange: z.string(),
        liveCalls: z.number().int(),
        lastSetupMs: z.number().nullable(),
        lastError: z.object({ reason: z.string(), at: z.string() }).nullable(),
        failedSetups15m: z.number().int(),
      })
      .nullable()
      .openapi({ description: 'Phase 18B: WhatsApp call audio; null when WhatsApp is off' }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/system',
  tags,
  summary: 'Production health for superadmins: build, database, Redis, queues, backups (Phase 17)',
  security: bearer,
  responses: { 200: ok(SystemStatusSchema), 401: errors[401], 403: errors[403] },
});

// Phase 19: resellers and signup settings
registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/accounts/{id}/reseller',
  tags,
  summary: 'Move a business under a reseller, or back to direct (superadmin)',
  security: bearer,
  request: { params: AccountIdParams, ...json(SetResellerBody) },
  responses: {
    200: ok(PublicAccountSchema),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/approve-reseller',
  tags,
  summary: 'Approve a reseller waiting for approval (superadmin)',
  security: bearer,
  request: { params: AccountIdParams },
  responses: { 200: ok(PublicAccountSchema), 403: errors[403], 404: errors[404], 409: errors[409] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/accounts/{id}/suspend-customers',
  tags,
  summary: 'Suspend every active customer of a reseller (superadmin)',
  security: bearer,
  request: { params: AccountIdParams, ...json(SuspendBody) },
  responses: {
    200: ok(z.object({ suspended: z.number().int() })),
    403: errors[403],
    404: errors[404],
    409: errors[409],
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/settings/signup',
  tags,
  summary: 'Signup settings (superadmin)',
  security: bearer,
  responses: { 200: ok(SignupSettingsBody), 403: errors[403] },
});
registry.registerPath({
  method: 'put',
  path: '/api/v1/admin/settings/signup',
  tags,
  summary: 'Open / close signup and reseller signup (superadmin)',
  security: bearer,
  request: json(SignupSettingsBody),
  responses: { 200: ok(SignupSettingsBody), 403: errors[403], 422: errors[422] },
});
