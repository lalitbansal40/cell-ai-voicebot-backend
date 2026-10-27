import { REPORT_LIMITS } from '../../config/limits';
import { EMAIL_REPORT_TABS, REPORT_FREQUENCIES } from '../../db/models/report-subscription.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

const tabs = z.array(z.enum(EMAIL_REPORT_TABS)).min(1).max(EMAIL_REPORT_TABS.length);
const hour = z.number().int().min(0).max(23);

export const CreateSubscriptionBody = z.strictObject({
  frequency: z.enum(REPORT_FREQUENCIES),
  tabs: tabs.default(['overview']),
  hour: hour.default(9),
});

export const UpdateSubscriptionBody = z
  .strictObject({
    frequency: z.enum(REPORT_FREQUENCIES).optional(),
    tabs: tabs.optional(),
    hour: hour.optional(),
    active: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

export const SubscriptionParams = z.strictObject({ id: ObjectIdSchema });
const token = z.string().min(10).max(200);
/** JSON `{ token }` from the page, or a mail app's one-click form post (`List-Unsubscribe=One-Click`, token in the query). */
export const UnsubscribeBody = z.object({ token: token.optional() });
export const UnsubscribeQuery = z.strictObject({ token: token.optional() });

export const ReportSubscriptionSchema = registry.register(
  'ReportSubscription',
  z.object({
    id: z.string(),
    frequency: z.enum(REPORT_FREQUENCIES),
    tabs: z.array(z.enum(EMAIL_REPORT_TABS)),
    hour: z.number().int(),
    active: z.boolean(),
    lastSentPeriod: z.string().nullable(),
    createdAt: z.string(),
  }),
);

const tags = ['Report e-mails'];
const base = '/api/v1/report-subscriptions';
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'My report e-mails (reports.read)',
  security: bearer,
  responses: { 200: ok(z.array(ReportSubscriptionSchema)), 401: errors[401], 403: errors[403] },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary: `Get a report by e-mail (reports.read; ≤ ${String(REPORT_LIMITS.subscriptionsPerUser)} each; 422 REPORT_SUBSCRIPTION_LIMIT)`,
  security: bearer,
  request: json(CreateSubscriptionBody),
  responses: {
    201: ok(ReportSubscriptionSchema),
    401: errors[401],
    403: errors[403],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}`,
  tags,
  summary: 'Change or pause one of my report e-mails',
  security: bearer,
  request: { params: SubscriptionParams, ...json(UpdateSubscriptionBody) },
  responses: {
    200: ok(ReportSubscriptionSchema),
    401: errors[401],
    403: errors[403],
    404: errors[404],
    422: errors[422],
  },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary: 'Stop one of my report e-mails',
  security: bearer,
  request: { params: SubscriptionParams },
  responses: {
    204: { description: 'Deleted' },
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/report-unsubscribe',
  tags,
  summary:
    'One-click stop from the e-mail link (no login; 20 / min / IP; token in the body or, for mail apps (RFC 8058), the query; 422 for a bad or old link)',
  request: { query: UnsubscribeQuery, ...json(UnsubscribeBody) },
  responses: {
    200: ok(z.object({ stopped: z.literal(true) })),
    422: errors[422],
    429: errors[429],
  },
});
