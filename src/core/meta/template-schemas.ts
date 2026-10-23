import { z } from 'zod';

import type {
  MetaPricingPoint,
  MetaTemplate,
  MetaTemplateCreated,
  MetaTemplatePage,
} from './types';

// Meta adds fields over time → every Meta object is loose (unknown keys allowed).
// Shapes re-checked on Meta's references 23 Oct 2026 (PHASE_11_PLAN changelog).

const id = z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String);
const optStr = z.string().nullish();
const num = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);

// ── Graph answers ───────────────────────────────────────────────────────────

export const templateSchema = z.looseObject({
  id: id,
  name: z.string().min(1),
  language: z.string().min(1),
  status: z.string().min(1),
  category: z.string().min(1),
  sub_category: optStr,
  parameter_format: optStr,
  components: z.array(z.looseObject({ type: z.string().min(1) })).default([]),
  quality_score: z.looseObject({ score: optStr }).nullish(),
  rejected_reason: optStr,
  message_send_ttl_seconds: z.number().int().nullish(),
});

export const templateListSchema = z.looseObject({
  data: z.array(templateSchema).default([]),
  paging: z
    .looseObject({
      cursors: z.looseObject({ before: optStr, after: optStr }).nullish(),
      next: optStr,
    })
    .nullish(),
});

export const templateCreatedSchema = z.looseObject({
  id: id,
  status: z.string().min(1),
  category: z.string().min(1),
});

const pricingPointSchema = z.looseObject({
  start: z.number(),
  end: z.number(),
  country: optStr,
  pricing_category: optStr,
  pricing_type: optStr,
  tier: optStr,
  volume: num.default(0),
  cost: num.default(0),
});

export const pricingAnalyticsSchema = z.looseObject({
  pricing_analytics: z
    .looseObject({
      data: z
        .array(z.looseObject({ data_points: z.array(pricingPointSchema).default([]) }))
        .default([]),
    })
    .nullish(),
  id: id.nullish(),
});

export const toTemplate = (raw: z.infer<typeof templateSchema>): MetaTemplate => ({
  id: raw.id,
  name: raw.name,
  language: raw.language,
  status: raw.status.toUpperCase(),
  category: raw.category.toUpperCase(),
  subCategory: raw.sub_category ?? null,
  parameterFormat: raw.parameter_format?.toLowerCase() === 'named' ? 'named' : 'positional',
  components: raw.components,
  qualityScore: raw.quality_score?.score?.toUpperCase() ?? null,
  rejectedReason: raw.rejected_reason ?? null,
  ttlSeconds: raw.message_send_ttl_seconds ?? null,
});

export const toTemplatePage = (raw: z.infer<typeof templateListSchema>): MetaTemplatePage => ({
  templates: raw.data.map(toTemplate),
  // Meta always sends cursors; only a `next` link means there is another page
  after: raw.paging?.next ? (raw.paging.cursors?.after ?? null) : null,
});

export const toTemplateCreated = (
  raw: z.infer<typeof templateCreatedSchema>,
): MetaTemplateCreated => ({
  id: raw.id,
  status: raw.status.toUpperCase(),
  category: raw.category.toUpperCase(),
});

export const toPricingPoints = (raw: z.infer<typeof pricingAnalyticsSchema>): MetaPricingPoint[] =>
  (raw.pricing_analytics?.data ?? []).flatMap((d) =>
    d.data_points.map((p) => ({
      start: new Date(p.start * 1000),
      end: new Date(p.end * 1000),
      country: p.country ?? null,
      category: p.pricing_category?.toLowerCase() ?? null,
      pricingType: p.pricing_type?.toLowerCase() ?? null,
      tier: p.tier ?? null,
      volume: p.volume,
      cost: p.cost,
    })),
  );

// ── Webhooks ────────────────────────────────────────────────────────────────

const templateRef = {
  message_template_id: id,
  message_template_name: z.string().min(1),
  message_template_language: z.string().min(1),
};

/** `message_template_status_update` — event = the new status (`APPROVED`, `REJECTED`, `PAUSED`, …). */
export const templateStatusValueSchema = z.looseObject({
  event: z.string().min(1),
  ...templateRef,
  reason: optStr,
  message_template_category: optStr,
  other_info: z.looseObject({ title: optStr, description: optStr }).nullish(),
  rejection_info: z.looseObject({ reason: optStr, recommendation: optStr }).nullish(),
  disable_info: z.looseObject({ disable_date: z.number().nullish() }).nullish(),
});

export const templateQualityValueSchema = z.looseObject({
  ...templateRef,
  previous_quality_score: optStr,
  new_quality_score: z.string().min(1),
});

/**
 * `template_category_update` — two variants: a pending change (`correct_category` +
 * `category_update_timestamp`, applied in 24 h) and the done change (`previous_category`).
 */
export const templateCategoryValueSchema = z.looseObject({
  ...templateRef,
  new_category: z.string().min(1),
  previous_category: optStr,
  correct_category: optStr,
  category_update_timestamp: z.number().nullish(),
});

/** `message_template_components_update` — texts are template content (never logged). */
export const templateComponentsValueSchema = z.looseObject({
  ...templateRef,
  message_template_element: optStr,
  message_template_title: optStr,
  message_template_footer: optStr,
  message_template_buttons: z
    .array(
      z.looseObject({
        message_template_button_type: optStr,
        message_template_button_text: optStr,
        message_template_button_url: optStr,
        message_template_button_phone_number: optStr,
      }),
    )
    .nullish(),
});

export const MARKETING_PREFERENCE_VALUES = ['stop', 'resume'] as const;

/** `user_preferences` — a customer stopped / resumed marketing messages (WhatsApp setting). */
export const userPreferencesValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp').nullish(),
  metadata: z.looseObject({ display_phone_number: optStr, phone_number_id: id }).nullish(),
  user_preferences: z
    .array(
      z.looseObject({
        wa_id: z.string().min(1),
        user_id: optStr,
        detail: optStr,
        category: z.string().min(1),
        value: z.string().min(1),
        timestamp: z.union([z.string(), z.number()]),
      }),
    )
    .min(1),
});

/** `account_update` with `event: VOLUME_BASED_PRICING_TIER_UPDATE`. */
export const volumeTierInfoSchema = z.looseObject({
  tier_update_time: z.number().nullish(),
  pricing_category: z.string().min(1),
  tier: z.string().min(1),
  effective_month: optStr,
  region: optStr,
});

export const VOLUME_TIER_EVENT = 'VOLUME_BASED_PRICING_TIER_UPDATE';

/** Value schemas of the Phase 11 webhook fields (handlers in `modules/templates`). */
export const TEMPLATE_WEBHOOK_VALUE_SCHEMAS = {
  message_template_status_update: templateStatusValueSchema,
  message_template_quality_update: templateQualityValueSchema,
  template_category_update: templateCategoryValueSchema,
  message_template_components_update: templateComponentsValueSchema,
  user_preferences: userPreferencesValueSchema,
} as const;
export type TemplateWebhookField = keyof typeof TEMPLATE_WEBHOOK_VALUE_SCHEMAS;
