import { ErrorEnvelopeSchema, successEnvelope } from '../../shared/openapi/common.schemas';
import { registry } from '../../shared/openapi/registry';
import { z } from '../../shared/openapi/zod';

/** Shape returned by `getAppInfo()` (src/index.ts). */
export const AppInfoSchema = registry.register(
  'AppInfo',
  z.object({
    name: z.string().openapi({ example: 'cell-ai-voicebot-backend' }),
    version: z.string().openapi({ example: '0.0.1' }),
    node: z.string().openapi({ example: 'v24.19.0' }),
    env: z.string().openapi({ example: 'development' }),
  }),
);

export type AppInfoDto = z.infer<typeof AppInfoSchema>;

// Documented now; the route itself is implemented in Phase 1.
registry.registerPath({
  method: 'get',
  path: '/api/v1/system/info',
  tags: ['System'],
  summary: 'Service name, version and runtime',
  responses: {
    200: {
      description: 'App info',
      content: { 'application/json': { schema: successEnvelope(AppInfoSchema) } },
    },
    500: {
      description: 'Unexpected error',
      content: { 'application/json': { schema: ErrorEnvelopeSchema } },
    },
  },
});
