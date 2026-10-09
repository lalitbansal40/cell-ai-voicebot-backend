import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

export const AiConfigSchema = registry.register(
  'AdminAiConfig',
  z.object({
    provider: z.enum(['openai', 'fake']),
    textModels: z.array(z.string()),
    defaultTextModel: z.string(),
    embeddingModel: z.string(),
    mockApisEnabled: z.boolean(),
    allowPrivateHosts: z.boolean(),
    openaiKeyConfigured: z
      .boolean()
      .openapi({ description: 'Whether a key is set — never the key' }),
  }),
);

registry.registerPath({
  method: 'get',
  path: '/api/v1/admin/ai/config',
  tags: ['Admin · AI'],
  summary:
    'AI provider, models and dev switches of this server (superadmin, platform.billing.manage)',
  security: bearer,
  responses: { 200: ok(AiConfigSchema), 401: errors[401], 403: errors[403] },
});
