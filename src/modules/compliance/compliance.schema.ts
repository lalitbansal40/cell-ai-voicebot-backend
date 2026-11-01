import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CeilingBody = z.strictObject({
  start: z.string().regex(HHMM, 'Must be HH:mm (24 h)'),
  end: z.string().regex(HHMM, 'Must be HH:mm (24 h)'),
});

export const ComplianceSchema = registry.register(
  'Compliance',
  z.object({
    callingWindow: z.object({
      start: z.string(),
      end: z.string(),
      days: z.array(z.number()),
    }),
    ceiling: z.object({ start: z.string(), end: z.string() }),
    timezone: z.string(),
    aiDisclosureEnabled: z.boolean(),
    recordingEnabled: z.boolean(),
    requireOptInForMarketing: z.boolean(),
    optOutKeywords: z.array(z.string()),
    counts: z.object({
      contacts: z.number(),
      withConsent: z.number(),
      dnd: z.number(),
      optedOut: z.number(),
      suppressed: z.number(),
    }),
  }),
);

const tags = ['Compliance'];

registry.registerPath({
  method: 'get',
  path: '/api/v1/account/compliance',
  tags,
  summary: 'The calling, consent and opt-out rules in force, with counts (account.read)',
  security: bearer,
  responses: { 200: ok(ComplianceSchema), 403: errors[403] },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/account/compliance/export',
  tags,
  summary: 'CSV of DND and opt-out changes; phones masked without contacts.export (account.read)',
  security: bearer,
  responses: {
    200: { description: 'CSV file', content: { 'text/csv': { schema: z.string() } } },
    403: errors[403],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/compliance/ceiling',
  tags,
  summary: 'The widest calling window an account may save (superadmin)',
  security: bearer,
  responses: { 200: ok(CeilingBody), 403: errors[403] },
});

registry.registerPath({
  method: 'put',
  path: '/api/v1/admin/compliance/ceiling',
  tags,
  summary: 'Change the widest calling window an account may save (superadmin)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: CeilingBody } } } },
  responses: { 200: ok(CeilingBody), 403: errors[403], 422: errors[422] },
});
