import { WEBHOOK_DELIVERY_STATUSES } from '../../db/models/webhook-delivery.model';
import { WEBHOOK_DISABLED_REASONS } from '../../db/models/webhook-endpoint.model';
import { registry } from '../../shared/openapi/registry';
import {
  bearerOrKey,
  errors,
  noContentResponse,
  ok,
  PUBLIC_API_TAG,
} from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { WEBHOOK_EVENT_TYPES } from './events';

const events = z
  .array(z.enum([...WEBHOOK_EVENT_TYPES, '*']))
  .min(1)
  .refine((e) => new Set(e).size === e.length, 'Events must be unique')
  .openapi({ description: 'Event types, or `["*"]` for every event', example: ['call.completed'] });
const url = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .openapi({ example: 'https://example.com/hooks/notifynow' });
const description = z.string().trim().max(200);

export const CreateEndpointBody = z.strictObject({
  url,
  description: description.optional(),
  events,
  includePersonalData: z.boolean().optional(),
});

export const UpdateEndpointBody = z
  .strictObject({
    url: url.optional(),
    description: description.optional(),
    events: events.optional(),
    includePersonalData: z.boolean().optional(),
    /** `false` pauses deliveries (reason `manual`); use `/enable` to turn it on again. */
    active: z.literal(false).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one field');

export const EndpointParams = z.strictObject({ id: ObjectIdSchema });
export const TestEventBody = z.strictObject({ type: z.enum(WEBHOOK_EVENT_TYPES) });

export const DeliveriesQuery = z.strictObject({
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
  type: z.enum(WEBHOOK_EVENT_TYPES).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: z
    .string()
    .regex(/^[0-9a-f]{24}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(50),
});

export const WebhookEndpointSchema = registry.register(
  'WebhookEndpoint',
  z.object({
    id: z.string(),
    url: z.string(),
    description: z.string(),
    events: z.array(z.string()),
    includePersonalData: z.boolean(),
    active: z.boolean(),
    disabledReason: z.enum(WEBHOOK_DISABLED_REASONS).nullable(),
    disabledAt: z.string().nullable(),
    failureStreak: z.number().int(),
    lastDeliveryAt: z.string().nullable(),
    lastDeliveryStatus: z.enum(['succeeded', 'failed']).nullable(),
    rotatedAt: z.string().nullable(),
    createdAt: z.string(),
  }),
);

export const EndpointWithSecretSchema = registry.register(
  'WebhookEndpointWithSecret',
  z.object({
    endpoint: WebhookEndpointSchema,
    secret: z
      .string()
      .openapi({ description: 'Signing secret `whsec_…` — shown only once, store it now.' }),
  }),
);

export const WebhookDeliverySchema = registry.register(
  'WebhookDelivery',
  z.object({
    id: z.string(),
    endpointId: z.string(),
    eventId: z.string(),
    type: z.string(),
    test: z.boolean(),
    status: z.enum(WEBHOOK_DELIVERY_STATUSES),
    attempt: z.number().int(),
    nextAttemptAt: z.string().nullable(),
    lastAttemptAt: z.string().nullable(),
    responseStatus: z.number().int().nullable(),
    responseMs: z.number().int().nullable(),
    responseSnippet: z
      .string()
      .nullable()
      .openapi({ description: 'First 1 KB of the answer, text only' }),
    error: z.string().nullable(),
    attempts: z.array(
      z.object({
        attempt: z.number().int(),
        at: z.string(),
        ok: z.boolean(),
        responseStatus: z.number().int().nullable(),
        responseMs: z.number().int(),
        error: z.string().nullable(),
      }),
    ),
    createdAt: z.string(),
  }),
);

const tags = ['Webhooks', PUBLIC_API_TAG];
const base = '/api/v1/webhook-endpoints';
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const path = (
  method: 'get' | 'post' | 'patch' | 'delete',
  p: string,
  summary: string,
  extra: Record<string, unknown>,
) =>
  registry.registerPath({
    method,
    path: p,
    tags,
    summary,
    security: bearerOrKey,
    responses: { 403: errors[403], 404: errors[404], 422: errors[422] },
    ...extra,
  });

path('get', base, 'Webhook endpoints of the account (integrations.manage / webhooks:manage)', {
  responses: { 200: ok(z.array(WebhookEndpointSchema)), 403: errors[403] },
});
path(
  'post',
  base,
  'Add an endpoint (≤ 10; https in production; private addresses refused → 422 WEBHOOK_URL_BLOCKED). The secret is returned once.',
  {
    request: json(CreateEndpointBody),
    responses: { 201: ok(EndpointWithSecretSchema), 403: errors[403], 422: errors[422] },
  },
);
path('get', `${base}/{id}`, 'One endpoint', {
  request: { params: EndpointParams },
  responses: { 200: ok(WebhookEndpointSchema), 403: errors[403], 404: errors[404] },
});
path(
  'patch',
  `${base}/{id}`,
  'Change URL, description, events, personal data, or pause (`active: false`)',
  {
    request: { params: EndpointParams, ...json(UpdateEndpointBody) },
    responses: {
      200: ok(WebhookEndpointSchema),
      403: errors[403],
      404: errors[404],
      422: errors[422],
    },
  },
);
path('delete', `${base}/{id}`, 'Remove an endpoint (its delivery log expires after 30 days)', {
  request: { params: EndpointParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404] },
});
path(
  'post',
  `${base}/{id}/test`,
  'Send a sample event now and see the answer (logged as a test delivery, never retried)',
  {
    request: { params: EndpointParams, ...json(TestEventBody) },
    responses: {
      200: ok(z.object({ ok: z.boolean(), delivery: WebhookDeliverySchema })),
      403: errors[403],
      404: errors[404],
    },
  },
);
path(
  'post',
  `${base}/{id}/rotate-secret`,
  'New signing secret (shown once); the old one keeps signing for 24 hours',
  {
    request: { params: EndpointParams },
    responses: { 200: ok(EndpointWithSecretSchema), 403: errors[403], 404: errors[404] },
  },
);
path('post', `${base}/{id}/enable`, 'Turn a disabled endpoint on again (failure streak reset)', {
  request: { params: EndpointParams },
  responses: { 200: ok(WebhookEndpointSchema), 403: errors[403], 404: errors[404] },
});
path(
  'get',
  `${base}/{id}/deliveries`,
  'Delivery log, newest first (30 days; filters: status, type, from / to; cursor)',
  {
    request: { params: EndpointParams, query: DeliveriesQuery },
    responses: {
      200: ok(
        z.object({ items: z.array(WebhookDeliverySchema), nextCursor: z.string().nullable() }),
      ),
      403: errors[403],
      404: errors[404],
    },
  },
);
path(
  'post',
  '/api/v1/webhook-deliveries/{id}/replay',
  'Deliver again now (same event id; one attempt)',
  {
    request: { params: EndpointParams },
    responses: {
      202: ok(WebhookDeliverySchema),
      403: errors[403],
      404: errors[404],
      409: errors[409],
    },
  },
);
