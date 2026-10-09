import { GST_STATE_CODES } from '../../shared/gst-states';
import { gstinProblem } from '../../shared/gstin';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

/** Latin letters only: the invoice PDF can't shape Devanagari (PHASE_4_PROMPT §1). */
const LATIN = /^[A-Za-z0-9 .,\-/&()'#]+$/;
const LATIN_MESSAGE = 'Use English letters, as on your GST registration';
const text = (max: number) =>
  z.string().trim().min(1).max(max).regex(LATIN, { message: LATIN_MESSAGE });

export const BillingProfileBody = z
  .strictObject({
    legalName: text(120),
    email: z
      .email()
      .max(254)
      .transform((e) => e.toLowerCase()),
    addressLine1: text(120),
    addressLine2: text(120).nullable().optional(),
    city: text(60),
    stateCode: z.string().refine((c) => GST_STATE_CODES.includes(c), 'Unknown GST state code'),
    pin: z.string().regex(/^[1-9][0-9]{5}$/, 'PIN must be 6 digits'),
    gstin: z
      .string()
      .trim()
      .transform((g) => g.toUpperCase())
      .nullable()
      .optional(),
  })
  .superRefine((b, ctx) => {
    if (!b.gstin) return;
    const problem = gstinProblem(b.gstin, b.stateCode);
    if (problem) {
      ctx.addIssue({
        code: 'custom',
        path: ['gstin'],
        message:
          problem === 'state'
            ? 'GSTIN belongs to a different state'
            : problem === 'checksum'
              ? 'GSTIN check digit is wrong'
              : 'Not a valid GSTIN',
      });
    }
  });

export const BillingProfileSchema = registry.register(
  'BillingProfile',
  z.object({
    legalName: z.string(),
    email: z.string(),
    addressLine1: z.string(),
    addressLine2: z.string().nullable(),
    city: z.string(),
    stateCode: z.string().openapi({ example: '08' }),
    pin: z.string(),
    gstin: z.string().nullable(),
    updatedAt: z.string(),
  }),
);

export const BillingProfileResponseSchema = registry.register(
  'BillingProfileResponse',
  z.object({
    profile: BillingProfileSchema.nullable(),
    complete: z.boolean(),
    sellerStateCode: z.string().openapi({ description: 'Same state → CGST + SGST, else IGST' }),
  }),
);

export const GstStateSchema = registry.register(
  'GstState',
  z.object({ code: z.string(), name: z.string() }),
);

const tags = ['Billing'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/billing/profile',
  tags,
  summary: 'Billing details for GST invoices (wallet.read)',
  security: bearer,
  responses: { 200: ok(BillingProfileResponseSchema), 403: errors[403] },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/billing/profile',
  tags,
  summary: 'Save billing details (wallet.topup; not while impersonating)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: BillingProfileBody } } } },
  responses: { 200: ok(BillingProfileResponseSchema), 403: errors[403], 422: errors[422] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/billing/states',
  tags,
  summary: 'GST state / union-territory codes',
  security: bearer,
  responses: { 200: ok(z.array(GstStateSchema)) },
});
