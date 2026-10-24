import { z } from 'zod';

import {
  WA_LIMIT_TIERS,
  WA_QUALITY,
  type WaLimitTier,
  type WaQuality,
} from '../../db/models/whatsapp-channel.model';

import { volumeTierInfoSchema } from './template-schemas';
import type {
  MetaAccessToken,
  MetaAllocation,
  MetaBusinessSummary,
  MetaCreditLineAttach,
  MetaDebugToken,
  MetaPhone,
  MetaPhoneSummary,
  MetaWaba,
  MetaWabaSummary,
} from './types';

// Meta adds fields over time → every Meta object is loose (unknown keys allowed).

const id = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
const optStr = z.string().nullish();

// ── Graph responses ─────────────────────────────────────────────────────────

export const oauthTokenSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: optStr,
  expires_in: z.number().nullish(),
});

export const debugTokenSchema = z.looseObject({
  data: z.looseObject({
    app_id: id.nullish(),
    type: optStr,
    application: optStr,
    is_valid: z.boolean(),
    expires_at: z.number().nullish(),
    data_access_expires_at: z.number().nullish(),
    user_id: id.nullish(),
    scopes: z.array(z.string()).default([]),
    granular_scopes: z
      .array(z.looseObject({ scope: z.string(), target_ids: z.array(id).nullish() }))
      .default([]),
  }),
});

const wabaSummarySchema = z.looseObject({ id, name: optStr });
const paging = z.looseObject({}).nullish();

export const ownedWabasSchema = z.looseObject({
  data: z.array(wabaSummarySchema),
  paging,
});

export const businessesSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id,
      name: optStr,
      owned_whatsapp_business_accounts: z
        .looseObject({ data: z.array(wabaSummarySchema) })
        .nullish(),
    }),
  ),
  paging,
});

export const wabaSchema = z.looseObject({
  id,
  name: optStr,
  currency: optStr,
  timezone_id: id.nullish(),
  message_template_namespace: optStr,
  account_review_status: optStr,
  business_verification_status: optStr,
  owner_business_info: z.looseObject({ id: id.nullish(), name: optStr }).nullish(),
  primary_funding_id: id.nullish(),
});

const phoneSummarySchema = z.looseObject({
  id,
  display_phone_number: optStr,
  verified_name: optStr,
  status: optStr,
});

export const phoneListSchema = z.looseObject({ data: z.array(phoneSummarySchema), paging });

export const phoneSchema = z.looseObject({
  id,
  display_phone_number: optStr,
  verified_name: optStr,
  name_status: optStr,
  new_name_status: optStr,
  quality_rating: optStr,
  messaging_limit_tier: optStr,
  code_verification_status: optStr,
  platform_type: optStr,
  throughput: z.looseObject({ level: optStr }).nullish(),
  account_mode: optStr,
  status: optStr,
  is_official_business_account: z.boolean().nullish(),
  is_on_biz_app: z.boolean().nullish(),
});

/** `{ success: true }` answers (subscribe, unsubscribe, assigned users, register). */
export const successSchema = z.looseObject({ success: z.literal(true) });

export const meSchema = z.looseObject({ id });

export const creditLineAttachSchema = z.looseObject({
  allocation_config_id: id,
  waba_id: id.nullish(),
});

export const allocationSchema = z.looseObject({
  id,
  receiving_credential: z.looseObject({ id }).nullish(),
});

export const syncRequestSchema = z.looseObject({
  success: z.literal(true),
  request_id: optStr,
});

// ── Mappers (shared by the Graph and the fake client) ───────────────────────

const orNull = <T>(v: T | null | undefined): T | null => v ?? null;

export const toAccessToken = (raw: z.infer<typeof oauthTokenSchema>): MetaAccessToken => ({
  accessToken: raw.access_token,
  tokenType: orNull(raw.token_type),
});

export const toDebugToken = ({ data }: z.infer<typeof debugTokenSchema>): MetaDebugToken => ({
  isValid: data.is_valid,
  type: orNull(data.type),
  appId: orNull(data.app_id),
  userId: orNull(data.user_id),
  expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null,
  scopes: data.scopes,
  grantedWabaIds: [
    ...new Set(
      data.granular_scopes
        .filter((s) => s.scope === 'whatsapp_business_management')
        .flatMap((s) => s.target_ids ?? []),
    ),
  ],
});

const toWabaSummary = (w: z.infer<typeof wabaSummarySchema>): MetaWabaSummary => ({
  id: w.id,
  name: orNull(w.name),
});

export const toOwnedWabas = (raw: z.infer<typeof ownedWabasSchema>): MetaWabaSummary[] =>
  raw.data.map(toWabaSummary);

export const toBusinesses = (raw: z.infer<typeof businessesSchema>): MetaBusinessSummary[] =>
  raw.data.map((b) => ({
    id: b.id,
    name: orNull(b.name),
    wabas: (b.owned_whatsapp_business_accounts?.data ?? []).map(toWabaSummary),
  }));

export const toWaba = (raw: z.infer<typeof wabaSchema>): MetaWaba => ({
  id: raw.id,
  name: orNull(raw.name),
  currency: orNull(raw.currency),
  timezoneId: orNull(raw.timezone_id),
  templateNamespace: orNull(raw.message_template_namespace),
  reviewStatus: orNull(raw.account_review_status),
  businessVerificationStatus: orNull(raw.business_verification_status),
  businessId: orNull(raw.owner_business_info?.id),
  businessName: orNull(raw.owner_business_info?.name),
  primaryFundingId: orNull(raw.primary_funding_id),
});

export const toPhoneSummaries = (raw: z.infer<typeof phoneListSchema>): MetaPhoneSummary[] =>
  raw.data.map((p) => ({
    id: p.id,
    displayPhoneNumber: orNull(p.display_phone_number),
    verifiedName: orNull(p.verified_name),
    status: orNull(p.status),
  }));

/** Unknown / missing quality (Meta also sends `NA`) → `UNKNOWN`. */
export const normalizeQuality = (value: string | null | undefined): WaQuality => {
  const upper = value?.toUpperCase();
  return (WA_QUALITY as readonly string[]).includes(upper ?? '') ? (upper as WaQuality) : 'UNKNOWN';
};

/** Unknown tiers → `null` (shown as "Not set"). */
export const normalizeTier = (value: string | null | undefined): WaLimitTier | null => {
  const upper = value?.toUpperCase();
  return (WA_LIMIT_TIERS as readonly string[]).includes(upper ?? '')
    ? (upper as WaLimitTier)
    : null;
};

export const toPhone = (raw: z.infer<typeof phoneSchema>): MetaPhone => ({
  id: raw.id,
  displayPhoneNumber: orNull(raw.display_phone_number),
  verifiedName: orNull(raw.verified_name),
  nameStatus: orNull(raw.name_status),
  newNameStatus: orNull(raw.new_name_status),
  qualityRating: normalizeQuality(raw.quality_rating),
  messagingLimitTier: normalizeTier(raw.messaging_limit_tier),
  codeVerificationStatus: orNull(raw.code_verification_status),
  platformType: orNull(raw.platform_type),
  throughputLevel: orNull(raw.throughput?.level),
  accountMode: orNull(raw.account_mode),
  status: orNull(raw.status),
  isOfficialBusinessAccount: raw.is_official_business_account ?? false,
  isOnBizApp: raw.is_on_biz_app ?? false,
});

export const toCreditLineAttach = (
  raw: z.infer<typeof creditLineAttachSchema>,
): MetaCreditLineAttach => ({ allocationConfigId: raw.allocation_config_id });

export const toAllocation = (raw: z.infer<typeof allocationSchema>): MetaAllocation => ({
  id: raw.id,
  receivingCredentialId: orNull(raw.receiving_credential?.id),
});

// ── Webhooks ────────────────────────────────────────────────────────────────

/** Fields subscribed in the Meta app (setup guide); Phase 9 handles some, stores the rest. */
export const WEBHOOK_FIELDS = [
  'messages',
  'calls',
  /** Phase 12: call settings changed (status / icon / callback / SIP). */
  'account_settings_update',
  'account_update',
  'phone_number_quality_update',
  'phone_number_name_update',
  'business_capability_update',
  'message_template_status_update',
  'message_template_quality_update',
  'template_category_update',
  'message_template_components_update',
  'user_preferences',
  'security',
  'history',
  'smb_app_state_sync',
  'smb_message_echoes',
] as const;
export type WebhookField = (typeof WEBHOOK_FIELDS)[number];

export const WEBHOOK_OBJECT = 'whatsapp_business_account';

export const webhookChangeSchema = z.looseObject({
  field: z.string().min(1).max(100),
  value: z.unknown(),
});

export const webhookEnvelopeSchema = z.looseObject({
  object: z.string(),
  entry: z
    .array(
      z.looseObject({
        id: id,
        time: z.number().nullish(),
        changes: z.array(webhookChangeSchema).default([]),
      }),
    )
    .default([]),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

const metadataSchema = z.looseObject({
  display_phone_number: optStr,
  phone_number_id: id,
});

export const accountUpdateValueSchema = z.looseObject({
  event: z.string().min(1),
  phone_number: id.nullish(),
  ban_info: z
    .looseObject({ waba_ban_state: z.array(z.string()).nullish(), waba_ban_date: optStr })
    .nullish(),
  restriction_info: z
    .array(z.looseObject({ restriction_type: z.string(), expiration: z.number().nullish() }))
    .nullish(),
  violation_info: z.looseObject({ violation_type: optStr }).nullish(),
  /** `VOLUME_BASED_PRICING_TIER_UPDATE` (Phase 11). */
  volume_tier_info: volumeTierInfoSchema.nullish(),
});

export const qualityUpdateValueSchema = z.looseObject({
  display_phone_number: id,
  event: z.string().min(1),
  current_limit: optStr,
  old_limit: optStr,
});

export const nameUpdateValueSchema = z.looseObject({
  display_phone_number: id,
  decision: z.string().min(1),
  requested_verified_name: optStr,
  rejection_reason: optStr,
});

export const capabilityUpdateValueSchema = z.looseObject({
  max_daily_conversation_per_phone: z.number().nullish(),
  max_phone_numbers_per_business: z.number().nullish(),
  max_phone_numbers_per_waba: z.number().nullish(),
});

export const messageEchoesValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp'),
  metadata: metadataSchema,
  message_echoes: z.array(z.looseObject({ id: z.string(), type: z.string() })).min(1),
});

const historyErrorSchema = z.looseObject({ code: z.number(), title: optStr });

export const historyValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp'),
  metadata: metadataSchema,
  history: z
    .array(
      z.looseObject({
        metadata: z
          .looseObject({
            phase: z.number().nullish(),
            chunk_order: z.number().nullish(),
            progress: z.number().min(0).max(100).nullish(),
          })
          .nullish(),
        threads: z.array(z.looseObject({ id: z.string() })).nullish(),
        errors: z.array(historyErrorSchema).nullish(),
      }),
    )
    .min(1),
});

export const appStateSyncValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp'),
  metadata: metadataSchema,
  state_sync: z.array(z.looseObject({ type: z.string(), action: optStr })).min(1),
});

/** `messages` / `calls` — Phase 9 only reads the routing metadata (Phase 10 / 12 parse the rest). */
export const routedValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp').nullish(),
  metadata: metadataSchema,
});

/** Schemas for the change values Phase 9 reads (others are stored as is). */
export const WEBHOOK_VALUE_SCHEMAS = {
  account_update: accountUpdateValueSchema,
  phone_number_quality_update: qualityUpdateValueSchema,
  phone_number_name_update: nameUpdateValueSchema,
  business_capability_update: capabilityUpdateValueSchema,
  smb_message_echoes: messageEchoesValueSchema,
  history: historyValueSchema,
  smb_app_state_sync: appStateSyncValueSchema,
  messages: routedValueSchema,
  calls: routedValueSchema,
} as const;

/**
 * The number a change is about (routing): `value.metadata.phone_number_id`, or
 * `phone_number_settings.phone_number_id` (`account_settings_update`, Phase 12), else `null`.
 */
export const phoneNumberIdOf = (value: unknown): string | null => {
  const parsed = z.looseObject({ metadata: metadataSchema }).safeParse(value);
  if (parsed.success) return parsed.data.metadata.phone_number_id;
  const settings = z
    .looseObject({ phone_number_settings: z.looseObject({ phone_number_id: id }) })
    .safeParse(value);
  return settings.success ? settings.data.phone_number_settings.phone_number_id : null;
};
