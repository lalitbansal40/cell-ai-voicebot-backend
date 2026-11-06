import { Router } from 'express';

import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { NotFoundError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  requirePermission,
  requirePlatformAdmin,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { resolveVoiceBatch } from '../campaigns/voice-api/batch';
import { handleAccountVoiceWebhook, handleVoiceWebhook } from '../campaigns/voice-api/results';

import {
  AccountVoiceApiBody,
  AccountVoiceWebhookParams,
  VoiceCredentialsBody,
  ResolveVoiceBatchBody,
  VoiceAccountParams,
  VoiceBatchParams,
  VoiceWebhookParams,
} from './voice-api.schema';
import {
  accountIvrs,
  adminVoiceStatus,
  providerIvrs,
  registerAccountVoiceWebhook,
  registerVoiceWebhook,
  setAccountVoiceApi,
  setVoiceCredentials,
  voicePlatformAudit,
} from './voice-api.service';

/** `/api/v1/admin/*` — superadmin (VAPI); each route carries its own guard. */
export const createVoiceApiAdminRouter = (): Router => {
  const router = Router();
  const guard = [authenticate(), requirePlatformAdmin()];
  router.patch(
    '/accounts/:id/voice-api',
    ...guard,
    ...handle(
      { params: VoiceAccountParams, body: AccountVoiceApiBody },
      async ({ params, body, req, res }) => {
        ok(res, await setAccountVoiceApi(req, params.id, body));
      },
    ),
  );
  // per-account Cell24x7 login (own token, caller ID) and its result webhook
  router.put(
    '/accounts/:id/voice-api/credentials',
    ...guard,
    ...handle(
      { params: VoiceAccountParams, body: VoiceCredentialsBody },
      async ({ params, body, req, res }) => {
        ok(res, await setVoiceCredentials(req, params.id, body));
      },
    ),
  );
  router.post(
    '/accounts/:id/voice-api/webhook',
    ...guard,
    ...handle({ params: VoiceAccountParams }, async ({ params, req, res }) => {
      ok(res, await registerAccountVoiceWebhook(req, params.id));
    }),
  );
  router.get('/voice-api/status', ...guard, async (_req, res) => {
    ok(res, await adminVoiceStatus());
  });
  router.post('/voice-api/webhook', ...guard, async (req, res) => {
    ok(res, await registerVoiceWebhook(req));
  });
  router.get('/voice-api/ivrs', ...guard, async (_req, res) => {
    ok(res, await providerIvrs(true));
  });
  router.post(
    '/campaigns/:id/voice-batches/:no/resolve',
    ...guard,
    ...handle(
      { params: VoiceBatchParams, body: ResolveVoiceBatchBody },
      async ({ params, body, req, res }) => {
        const { campaign, batch } = await resolveVoiceBatch(params.id, params.no, body);
        await voicePlatformAudit(
          req,
          'voice_api.batch_resolved',
          { type: 'campaign', id: campaign._id.toString() },
          { batchNo: batch.no, outcome: body.outcome },
          campaign.accountId,
        );
        ok(res, { batchNo: batch.no, state: batch.state });
      },
    ),
  );
  return router;
};

/**
 * `POST /api/v1/webhooks/voice-api/:secret` — Cell24x7 results (public; the secret path is
 * the only credential, so polling re-checks everything). Answers at once, work is queued.
 */
export const createVoiceWebhookRouter = (): Router => {
  const router = Router();
  router.post(
    '/webhooks/voice-api/a/:account/:key',
    createRateLimiter({ windowMs: 60_000, limit: 600 }),
    ...handle({ params: AccountVoiceWebhookParams }, async ({ params, req, res }) => {
      if (!(await handleAccountVoiceWebhook(params.account, params.key, req.body)))
        throw new NotFoundError();
      ok(res, { received: true });
    }),
  );
  router.post(
    '/webhooks/voice-api/:secret',
    createRateLimiter({ windowMs: 60_000, limit: 600 }),
    ...handle({ params: VoiceWebhookParams }, async ({ params, req, res }) => {
      if (!(await handleVoiceWebhook(params.secret, req.body))) throw new NotFoundError();
      ok(res, { received: true });
    }),
  );
  return router;
};

/** `/api/v1/voice-api/*` — the account's own recorded-voice options. */
export const createVoiceApiRouter = (): Router => {
  const router = Router();
  router.get(
    '/voice-api/ivrs',
    authenticate(),
    requirePermission('campaigns.write'),
    async (req, res) => {
      requireAuth(req);
      ok(res, await accountIvrs(tenantFilter(req).accountId));
    },
  );
  return router;
};
