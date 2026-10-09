import { INVOICE_STATUSES } from '../../db/models/invoice.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';

import { BillingProfileSchema } from './billing.schema';

export const ListInvoicesQuery = z.strictObject({ ...PaginationQuerySchema.shape });
export const InvoiceIdParams = z.strictObject({ id: ObjectIdSchema });

export const InvoiceSchema = registry.register(
  'Invoice',
  z.object({
    id: z.string(),
    number: z.string().openapi({ example: 'CAV/26-27/000001' }),
    fy: z.string(),
    status: z.enum(INVOICE_STATUSES),
    seller: z.object({
      name: z.string(),
      address: z.string(),
      gstin: z.string().nullable(),
      stateCode: z.string(),
    }),
    buyer: BillingProfileSchema.omit({ updatedAt: true }),
    placeOfSupply: z.object({ stateCode: z.string(), stateName: z.string() }),
    sacCode: z.string(),
    amounts: z.object({
      baseMicros: z.number(),
      cgstMicros: z.number(),
      sgstMicros: z.number(),
      igstMicros: z.number(),
      taxMicros: z.number(),
      totalMicros: z.number(),
    }),
    paymentId: z.string(),
    topupOrderId: z.string(),
    issuedAt: z.string(),
  }),
);

const tags = ['Billing'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/invoices',
  tags,
  summary: 'GST invoices of the account, newest first (wallet.read)',
  security: bearer,
  request: { query: ListInvoicesQuery },
  responses: { 200: okPage(InvoiceSchema), 403: errors[403] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/invoices/{id}',
  tags,
  summary: 'One invoice',
  security: bearer,
  request: { params: InvoiceIdParams },
  responses: { 200: ok(InvoiceSchema), 403: errors[403], 404: errors[404] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/invoices/{id}/download',
  tags,
  summary: 'Signed link to the invoice PDF (15 min); 409 while the PDF is being made',
  security: bearer,
  request: { params: InvoiceIdParams },
  responses: {
    200: ok(z.object({ url: z.string(), expiresInSec: z.number() })),
    403: errors[403],
    404: errors[404],
    409: errors[409],
  },
});
