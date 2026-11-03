import {
  PHONE_NUMBER_KINDS,
  PHONE_NUMBER_PURPOSES,
  PHONE_NUMBER_STATUSES,
} from '../../db/models/phone-number.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

const E164 = /^\+[1-9]\d{7,14}$/;
const objectId = z.string().regex(/^[a-f0-9]{24}$/, 'Must be an id');

export const PhoneNumberIdParams = z.strictObject({ id: objectId });

export const CreatePhoneNumberBody = z.strictObject({
  number: z.string().trim().regex(E164, 'Must be an E.164 number, e.g. +911600000000'),
  kind: z.enum(PHONE_NUMBER_KINDS),
  label: z.string().trim().max(60).default(''),
  dltPrincipalEntityId: z.string().trim().max(40).nullable().default(null),
});

export const UpdatePhoneNumberBody = z
  .strictObject({
    kind: z.enum(PHONE_NUMBER_KINDS),
    label: z.string().trim().max(60),
    dltPrincipalEntityId: z.string().trim().max(40).nullable(),
    status: z.enum(PHONE_NUMBER_STATUSES),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

export const AssignPhoneNumberBody = z.strictObject({ accountId: objectId });

export const ListPhoneNumbersQuery = z.strictObject({
  accountId: objectId.optional(),
  status: z.enum(PHONE_NUMBER_STATUSES).optional(),
});

export const PhoneNumberSchema = registry.register(
  'PhoneNumber',
  z.object({
    id: z.string(),
    number: z.string(),
    kind: z.enum(PHONE_NUMBER_KINDS),
    accountId: z.string().nullable(),
    accountName: z.string().nullable(),
    purpose: z.enum(PHONE_NUMBER_PURPOSES),
    label: z.string(),
    dltPrincipalEntityId: z.string().nullable(),
    status: z.enum(PHONE_NUMBER_STATUSES),
    /** e.g. `not_1600_series` when kind 1600 doesn't look like one (a hint, not a block). */
    warnings: z.array(z.string()),
    createdAt: z.string(),
  }),
);

const tags = ['Phone numbers'];
const one = ok(PhoneNumberSchema);
const idPath = { params: PhoneNumberIdParams };

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/phone-numbers',
  tags,
  summary: 'Caller-ID numbers on the trunk, all accounts (superadmin)',
  security: bearer,
  request: { query: ListPhoneNumbersQuery },
  responses: { 200: ok(z.array(PhoneNumberSchema)), 403: errors[403] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/phone-numbers',
  tags,
  summary: 'Add a number to the pool (superadmin) — 409 PHONE_NUMBER_EXISTS',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: CreatePhoneNumberBody } } } },
  responses: { 201: one, 403: errors[403], 409: errors[409], 422: errors[422] },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/admin/phone-numbers/{id}',
  tags,
  summary: 'Change label, kind, DLT id or status (superadmin)',
  security: bearer,
  request: {
    ...idPath,
    body: { content: { 'application/json': { schema: UpdatePhoneNumberBody } } },
  },
  responses: { 200: one, 403: errors[403], 404: errors[404], 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/phone-numbers/{id}/assign',
  tags,
  summary: 'Give the number to an account (superadmin)',
  security: bearer,
  request: {
    ...idPath,
    body: { content: { 'application/json': { schema: AssignPhoneNumberBody } } },
  },
  responses: { 200: one, 403: errors[403], 404: errors[404], 409: errors[409] },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/admin/phone-numbers/{id}/release',
  tags,
  summary: 'Take the number back into the pool (superadmin)',
  security: bearer,
  request: idPath,
  responses: { 200: one, 403: errors[403], 404: errors[404] },
});
export const PhoneLineSchema = registry.register(
  'PhoneLine',
  z.object({ line: z.enum(['sip', 'dryrun']), numbers: z.array(PhoneNumberSchema) }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/phone-line',
  tags,
  summary: "This account's phone line (sip / dryrun) and active numbers (account.read)",
  security: bearer,
  responses: { 200: ok(PhoneLineSchema), 403: errors[403] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/phone-numbers',
  tags,
  summary: "This account's active caller-ID numbers (account.read)",
  security: bearer,
  responses: { 200: ok(z.array(PhoneNumberSchema)), 403: errors[403] },
});
