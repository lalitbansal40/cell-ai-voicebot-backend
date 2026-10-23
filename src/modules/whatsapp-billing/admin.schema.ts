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

export const SaveRateCardBody = z
  .object({
    markets: z.array(RateCardMarketBody).min(1).max(300),
    effectiveFrom: z.iso.datetime({ offset: true }).optional(),
    source: z.enum(RATE_CARD_SOURCES),
    note: z.string().trim().max(300).nullable().optional(),
  })
  .openapi('WhatsAppRateCardSave');

export const BillingSettingsBody = z
  .object({
    markupBps: z.number().int().min(0).max(100_000).optional(),
    platformFeeMicros: micros.optional(),
    holdMaxAgeHours: z.number().int().min(1).max(720).optional(),
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
