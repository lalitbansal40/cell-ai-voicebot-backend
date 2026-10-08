import { ErrorEnvelopeSchema, successEnvelope } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { z } from '../../shared/openapi/zod';

export const HealthSchema = registry.register(
  'Health',
  z.object({
    status: z.literal('ok'),
    uptimeSec: z.number().int().min(0).openapi({ example: 3600 }),
  }),
);

export const ReadinessSchema = registry.register(
  'Readiness',
  z.object({
    status: z.literal('ready'),
    checks: z
      .record(z.string(), z.literal('up'))
      .openapi({ example: { mongo: 'up', redis: 'up' } }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: ['System'],
  summary: 'Liveness — the process is up (no dependency checks)',
  responses: {
    200: {
      description: 'Alive',
      content: { 'application/json': { schema: successEnvelope(HealthSchema) } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/ready',
  tags: ['System'],
  summary: 'Readiness — MongoDB and Redis reachable and not shutting down',
  responses: {
    200: {
      description: 'Ready',
      content: { 'application/json': { schema: successEnvelope(ReadinessSchema) } },
    },
    503: {
      description: 'A dependency is down or the server is shutting down (PROVIDER_UNAVAILABLE)',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
  },
});
