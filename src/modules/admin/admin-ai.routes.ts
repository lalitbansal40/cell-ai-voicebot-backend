import { Router } from 'express';

import type { Env } from '../../config/env';
import type { AiProvider } from '../../core/ai/types';
import { ok } from '../../shared/http/envelope';
import { requirePermission } from '../../shared/middlewares/require-permission';

/**
 * `/api/v1/admin/ai/*` — mounted inside the admin router after
 * `requirePlatformAdmin()`; needs `platform.billing.manage`.
 */
export const createAdminAiRouter = ({
  env,
  provider,
}: {
  env: Pick<
    Env,
    | 'AI_TEXT_MODELS'
    | 'OPENAI_TEXT_MODEL'
    | 'OPENAI_EMBEDDING_MODEL'
    | 'MOCK_APIS_ENABLED'
    | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS'
    | 'OPENAI_API_KEY'
    | 'VOICE_PROVIDER'
    | 'VOICE_PIPELINE'
    | 'VOICE_TEXT_INPUT_ENABLED'
    | 'OPENAI_REALTIME_MODEL'
    | 'OPENAI_TTS_MODEL'
    | 'OPENAI_TRANSCRIBE_MODEL'
  >;
  provider: Pick<AiProvider, 'name'>;
}): Router => {
  const router = Router();
  router.get('/ai/config', requirePermission('platform.billing.manage'), (_req, res) => {
    ok(res, {
      provider: provider.name,
      textModels: [...env.AI_TEXT_MODELS],
      defaultTextModel: env.OPENAI_TEXT_MODEL,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL,
      mockApisEnabled: env.MOCK_APIS_ENABLED,
      allowPrivateHosts: env.AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS,
      openaiKeyConfigured: Boolean(env.OPENAI_API_KEY),
      voice: {
        provider: env.VOICE_PROVIDER,
        pipeline: env.VOICE_PIPELINE,
        realtimeModel: env.OPENAI_REALTIME_MODEL,
        ttsModel: env.OPENAI_TTS_MODEL,
        transcribeModel: env.OPENAI_TRANSCRIBE_MODEL,
        textInputEnabled: env.VOICE_TEXT_INPUT_ENABLED,
      },
    });
  });
  return router;
};
