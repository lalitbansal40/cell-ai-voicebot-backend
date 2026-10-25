import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

import {
  BillingSettingsBody,
  CallingRateMarketBody,
  MonthQuery,
  RateCardKindQuery,
  RateCardMarketBody,
  SaveRateCardBody,
} from './admin.schema';
import { PricePreviewBody, PricePreviewSchema } from './price-preview.schema';

const tags = ['WhatsApp billing'];

registry.registerPath({
  method: 'post',
  path: '/api/v1/whatsapp/price-preview',
  tags,
  summary:
    'Price of one WhatsApp message to a contact / phone: template category or service (inbox.read or templates.read)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: PricePreviewBody } } } },
  responses: {
    200: ok(PricePreviewSchema),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});

const adminTags = ['Admin · WhatsApp billing'];
const admin = { 401: errors[401], 403: errors[403], 422: errors[422] };
const market = RateCardMarketBody;
const card = z.object({
  id: z.string(),
  effectiveFrom: z.string(),
  currency: z.literal('INR'),
  source: z.enum(['meta_csv', 'manual']),
  note: z.string().nullable(),
  createdAt: z.string(),
  /** `messaging` cards fill `markets`, `calling` cards `callingMarkets` (Phase 12). */
  kind: z.enum(['messaging', 'calling']),
  markets: z.array(market),
  callingMarkets: z.array(CallingRateMarketBody),
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/whatsapp-rates',
  tags: adminTags,
  summary:
    "Meta's WhatsApp rate card in force, scheduled ones and history (platform.billing.manage); `kind=calling` for the per-minute calling cards",
  security: bearer,
  request: { query: RateCardKindQuery },
  responses: {
    200: ok(
      z.object({
        current: card.nullable(),
        scheduled: z.array(card),
        history: z.array(
          z.object({
            id: z.string(),
            effectiveFrom: z.string(),
            source: z.string(),
            note: z.string().nullable(),
            markets: z.number(),
          }),
        ),
      }),
    ),
    ...admin,
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp-rates/import',
  tags: adminTags,
  summary:
    "Preview Meta's INR rate card CSV (multipart `file`, ≤ 2 MB): markets, row errors, diff — nothing saved",
  security: bearer,
  request: {
    query: RateCardKindQuery,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({ file: z.string().openapi({ format: 'binary' }) }),
        },
      },
    },
  },
  responses: {
    200: ok(
      z.object({
        markets: z.array(market),
        callingMarkets: z.array(CallingRateMarketBody),
        errors: z.array(z.object({ row: z.number(), message: z.string() })),
        diff: z
          .object({
            added: z.array(z.string()),
            removed: z.array(z.string()),
            changed: z.array(
              z.object({
                market: z.string(),
                field: z.string(),
                fromMicros: z.number().nullable(),
                toMicros: z.number().nullable(),
              }),
            ),
          })
          .nullable(),
      }),
    ),
    ...admin,
    413: errors[413],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/whatsapp-rates',
  tags: adminTags,
  summary: 'Save a rate card (insert-only history; effectiveFrom now or later)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: SaveRateCardBody } } } },
  responses: { 201: ok(card, 'Created'), ...admin },
});
const callingSettings = z.object({
  markupBps: z.number(),
  platformFeePerMinuteMicros: z.number(),
  holdMinutes: z.number(),
  holdExtendMinutes: z.number(),
});
const settingsView = z.object({
  settings: z.object({
    markupBps: z.number(),
    platformFeeMicros: z.number(),
    holdMaxAgeHours: z.number(),
  }),
  defaults: z.object({
    markupBps: z.number(),
    platformFeeMicros: z.number(),
    holdMaxAgeHours: z.number(),
  }),
  nonInrPlatformChannels: z.array(
    z.object({
      channelId: z.string(),
      accountId: z.string(),
      label: z.string(),
      wabaCurrency: z.string(),
    }),
  ),
  /** Phase 12: the price of business-initiated WhatsApp calls. */
  calling: callingSettings,
  callingDefaults: callingSettings,
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/whatsapp-billing',
  tags: adminTags,
  summary:
    'Global WhatsApp markup / platform fee / hold age + platform-paid numbers not billed in INR (deadline 31 Dec 2026)',
  security: bearer,
  responses: { 200: ok(settingsView), ...admin },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/whatsapp-billing',
  tags: adminTags,
  summary: 'Change the global WhatsApp price settings',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: BillingSettingsBody } } } },
  responses: { 200: ok(settingsView), ...admin },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/reports/whatsapp-margin',
  tags: adminTags,
  summary:
    'Per account × category for a month: messages, billed, Meta cost (analytics or list), margin, mismatches; `format=csv` downloads',
  security: bearer,
  request: { query: MonthQuery },
  responses: {
    200: ok(
      z.array(
        z.object({
          accountId: z.string(),
          accountName: z.string(),
          /** `call` rows (Phase 12): WhatsApp calls, category `call`, `messages` = calls. */
          kind: z.enum(['message', 'call']),
          category: z.string(),
          messages: z.number(),
          billedMicros: z.number(),
          metaCostMicros: z.number(),
          metaCostSource: z.enum(['analytics', 'list']),
          marginMicros: z.number(),
          marginBps: z.number().nullable(),
          mismatches: z.number(),
        }),
      ),
    ),
    ...admin,
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/reports/whatsapp-reconciliation',
  tags: adminTags,
  summary: "Daily rows: Meta's pricing analytics vs our captured charges per WABA × category",
  security: bearer,
  request: { query: MonthQuery },
  responses: {
    200: ok(
      z.array(
        z.object({
          accountId: z.string(),
          wabaId: z.string(),
          day: z.string(),
          category: z.string(),
          metaVolume: z.number(),
          metaCostMicros: z.number(),
          ourCaptured: z.number(),
          ourBilledMicros: z.number(),
          diffVolume: z.number(),
          diffMicros: z.number(),
          fetchedAt: z.string(),
        }),
      ),
    ),
    ...admin,
  },
});
