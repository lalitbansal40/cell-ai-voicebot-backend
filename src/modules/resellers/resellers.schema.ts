import { OffsetPageMetaSchema } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import {
  ObjectIdSchema,
  PaginationQuerySchema,
  PhoneE164Schema,
} from '../../shared/validation/schemas';
import { AuthSessionSchema, EmailSchema, TimezoneSchema } from '../auth/auth.schema';

/** ₹1 … ₹1,00,00,000 per transfer, in micros. */
const amount = z.number().int().min(1_000_000).max(10_000_000_000_000);

export const CustomerIdParams = z.strictObject({ id: ObjectIdSchema });
export const ListCustomersQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});
export const CreateCustomerBody = z.strictObject({
  businessName: z.string().trim().min(2).max(80),
  ownerName: z.string().trim().min(1).max(80),
  ownerEmail: EmailSchema,
  ownerPhone: PhoneE164Schema.optional(),
  ownerPassword: z.string().min(1).max(200),
  timezone: TimezoneSchema.optional(),
  startingCreditMicros: amount.optional(),
});
export const UpdateCustomerBody = z
  .strictObject({
    name: z.string().trim().min(2).max(80).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((b) => b.name !== undefined || b.status !== undefined, {
    message: 'Nothing to change',
  });
export const OwnerPasswordBody = z.strictObject({ password: z.string().min(1).max(200) });
export const CreditBody = z.strictObject({
  amountMicros: amount,
  note: z.string().trim().max(200).optional(),
});
export const StatementQuery = z.strictObject({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  format: z.enum(['json', 'csv']).default('json'),
});
export const ResellerSettingsBody = z.strictObject({ customersCanTopUp: z.boolean() });

const CustomerRowSchema = registry.register(
  'ResellerCustomer',
  z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['active', 'suspended', 'deleted']),
    owner: z.object({ name: z.string(), email: z.string() }).nullable(),
    wallet: z.object({ balanceMicros: z.number().int(), availableMicros: z.number().int() }),
    spend30dMicros: z.number().int(),
    lastActiveAt: z.string().nullable(),
    createdAt: z.string(),
  }),
);
const TransferSchema = z.object({
  id: z.string(),
  direction: z.enum(['given', 'taken_back']),
  amountMicros: z.number().int(),
  note: z.string().nullable(),
  at: z.string(),
});
const CustomerDetailSchema = registry.register(
  'ResellerCustomerDetail',
  CustomerRowSchema.extend({ timezone: z.string(), transfers: z.array(TransferSchema) }),
);
const CreditResultSchema = registry.register(
  'ResellerCreditResult',
  z.object({
    transferId: z.string(),
    amountMicros: z.number().int(),
    resellerBalanceMicros: z.number().int(),
    customerBalanceMicros: z.number().int(),
    replay: z.boolean(),
  }),
);
const StatementRowSchema = registry.register(
  'ResellerStatementRow',
  z.object({
    id: z.string(),
    at: z.string(),
    direction: z.enum(['given', 'taken_back']),
    amountMicros: z.number().int(),
    balanceAfterMicros: z.number().int().nullable(),
    customer: z.object({ id: z.string(), name: z.string() }).nullable(),
    note: z.string().nullable(),
  }),
);
const SummarySchema = registry.register(
  'ResellerSummary',
  z.object({
    customers: z.object({ active: z.number(), suspended: z.number(), total: z.number() }),
    creditGivenThisMonthMicros: z.number().int(),
    customersSpend30d: z.object({
      calls: z.number().int(),
      whatsapp: z.number().int(),
      ai: z.number().int(),
      totalMicros: z.number().int(),
    }),
    lowBalanceCustomers: z.array(
      z.object({ id: z.string(), name: z.string(), availableMicros: z.number().int() }),
    ),
  }),
);

const tags = ['Reseller'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const fail = { 403: errors[403], 404: errors[404] };
type RouteExtra = Pick<Parameters<typeof registry.registerPath>[0], 'request' | 'responses'>;
const path = (method: 'get' | 'post' | 'patch', p: string, summary: string, extra: RouteExtra) =>
  registry.registerPath({
    method,
    path: `/api/v1/reseller${p}`,
    tags,
    security: bearer,
    summary,
    ...extra,
  });

path('get', '/summary', 'Dashboard numbers (reseller.read; cached 5 min)', {
  responses: { 200: ok(SummarySchema), ...fail },
});
path('get', '/customers', 'Customers with wallet, spend (30 d) and last sign-in (reseller.read)', {
  request: { query: ListCustomersQuery },
  responses: {
    200: {
      description: 'OK',
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            data: z.array(CustomerRowSchema),
            meta: OffsetPageMetaSchema,
          }),
        },
      },
    },
    ...fail,
  },
});
path(
  'post',
  '/customers',
  'Add a customer with its owner and password; optional starting credit (reseller.manage; 50 / day; Idempotency-Key)',
  {
    request: { headers: z.object({ 'idempotency-key': z.string() }), ...json(CreateCustomerBody) },
    responses: { 201: ok(CustomerRowSchema), ...fail, 409: errors[409], 422: errors[422] },
  },
);
path('get', '/customers/{id}', 'One customer + last 20 transfers (reseller.read)', {
  request: { params: CustomerIdParams },
  responses: { 200: ok(CustomerDetailSchema), ...fail },
});
path('patch', '/customers/{id}', 'Rename, suspend or enable a customer (reseller.manage)', {
  request: { params: CustomerIdParams, ...json(UpdateCustomerBody) },
  responses: { 200: ok(CustomerDetailSchema), ...fail, 422: errors[422] },
});
path(
  'post',
  '/customers/{id}/owner-password',
  "Set the customer owner's password; their sessions end (reseller.manage)",
  {
    request: { params: CustomerIdParams, ...json(OwnerPasswordBody) },
    responses: { 204: noContentResponse, ...fail, 422: errors[422] },
  },
);
path(
  'post',
  '/customers/{id}/login-as',
  'Log in as the customer owner to act (1 h; sensitive actions refused; reseller.manage)',
  {
    request: { params: CustomerIdParams },
    responses: { 200: ok(AuthSessionSchema), ...fail, 409: errors[409] },
  },
);
path(
  'post',
  '/customers/{id}/credit',
  "Give credit from the reseller's wallet (reseller.manage; Idempotency-Key; 60 / h)",
  {
    request: {
      params: CustomerIdParams,
      headers: z.object({ 'idempotency-key': z.string() }),
      ...json(CreditBody),
    },
    responses: { 200: ok(CreditResultSchema), ...fail, 409: errors[409], 422: errors[422] },
  },
);
path(
  'post',
  '/customers/{id}/credit/reclaim',
  'Take back unused credit (reseller.manage; Idempotency-Key; 60 / h)',
  {
    request: {
      params: CustomerIdParams,
      headers: z.object({ 'idempotency-key': z.string() }),
      ...json(CreditBody),
    },
    responses: { 200: ok(CreditResultSchema), ...fail, 409: errors[409], 422: errors[422] },
  },
);
path('get', '/statement', 'Credit given / taken back (reseller.read; `format=csv` downloads)', {
  request: { query: StatementQuery },
  responses: { 200: ok(z.array(StatementRowSchema)), ...fail },
});
path('get', '/settings', 'Reseller settings (reseller.read)', {
  responses: { 200: ok(ResellerSettingsBody), ...fail },
});
path('patch', '/settings', 'May customers top up by themselves (reseller.manage)', {
  request: json(ResellerSettingsBody),
  responses: { 200: ok(ResellerSettingsBody), ...fail },
});
