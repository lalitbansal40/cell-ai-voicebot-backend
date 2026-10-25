import { META_PAYERS } from '../../db/models/whatsapp-channel.model';
import { RATE_CARD_SOURCES } from '../../db/models/whatsapp-rate-card.model';
import { z } from '../../shared/openapi/zod';

const micros = z.number().int().min(0).max(1_000_000_000);
const tier = z.object({ fromMessages: z.number().int().min(0), micros });

export const RateCardMarketBody = z.object({
  market: z.string().regex(/^[A-Z_]{2,40}$/),
  label: z.string().trim().min(1).max(80),
  callingCodes: z.array(z.string().regex(/^\d{1,4}$/)).max(50),
  marketingMicros: micros,
  utilityMicros: micros,
  authenticationMicros: micros,
  authenticationInternationalMicros: micros.nullable(),
  serviceMicros: micros,
  utilityTiers: z.array(tier).max(10).default([]),
  authenticationTiers: z.array(tier).max(10).default([]),
});

/** Phase 12: one market of a calling card (Meta's per-minute business-initiated rate). */
export const CallingRateMarketBody = z.object({
  market: z.string().regex(/^[A-Z_]{2,40}$/),
  label: z.string().trim().min(1).max(80),
  callingCodes: z.array(z.string().regex(/^\d{1,4}$/)).max(50),
  perMinuteMicros: micros,
  tiers: z
    .array(z.object({ fromMinutes: z.number().int().min(0), perMinuteMicros: micros }))
    .max(10)
    .default([]),
});

export const RateCardKindQuery = z.object({
  kind: z.enum(['messaging', 'calling']).default('messaging'),
});

export const SaveRateCardBody = z
  .object({
    /** `calling` saves `callingMarkets` (Phase 12); default `messaging` saves `markets`. */
    kind: z.enum(['messaging', 'calling']).optional(),
    markets: z.array(RateCardMarketBody).min(1).max(300).optional(),
    callingMarkets: z.array(CallingRateMarketBody).min(1).max(300).optional(),
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    source: z.enum(RATE_CARD_SOURCES),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .superRefine((b, ctx) => {
    const kind = b.kind ?? 'messaging';
    const field = kind === 'calling' ? 'callingMarkets' : 'markets';
    const other = kind === 'calling' ? 'markets' : 'callingMarkets';
    if (!b[field]) ctx.addIssue({ code: 'custom', path: [field], message: 'Required' });
    if (b[other])
      ctx.addIssue({ code: 'custom', path: [other], message: `Not used on ${kind} cards` });
  })
  .openapi('WhatsAppRateCardSave');

/** Phase 12 call settings inside `PATCH /admin/whatsapp-billing`. */
export const CallingBillingSettingsBody = z
  .strictObject({
    markupBps: z.number().int().min(0).max(100_000).optional(),
    platformFeePerMinuteMicros: micros.optional(),
    holdMinutes: z.number().int().min(1).max(60).optional(),
    holdExtendMinutes: z.number().int().min(1).max(60).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update');

export const BillingSettingsBody = z
  .object({
    markupBps: z.number().int().min(0).max(100_000).optional(),
    platformFeeMicros: micros.optional(),
    holdMaxAgeHours: z.number().int().min(1).max(720).optional(),
    calling: CallingBillingSettingsBody.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update')
  .openapi('WhatsAppBillingSettingsPatch');

/** Phase 9 body (`metaPayer`) + the Phase 11 price override — at least one field. */
export const AccountWhatsAppBillingBody = z
  .strictObject({
    metaPayer: z.enum(META_PAYERS).optional(),
    markupBps: z.number().int().min(0).max(100_000).nullable().optional(),
    fixedPrices: z
      .strictObject({
        marketing: micros.optional(),
        utility: micros.optional(),
        authentication: micros.optional(),
        service: micros.optional(),
      })
      .nullable()
      .optional(),
    platformFeeMicros: micros.nullable().optional(),
    /** Phase 12: the account's call price (null clears the override). */
    calling: z
      .strictObject({
        markupBps: z.number().int().min(0).max(100_000).nullable().optional(),
        fixedPerMinuteMicros: micros.nullable().optional(),
        platformFeePerMinuteMicros: micros.nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update')
  .openapi('WhatsAppBillingInput');

export const MonthQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
  accountId: z
    .string()
    .regex(/^[a-f0-9]{24}$/)
    .optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
