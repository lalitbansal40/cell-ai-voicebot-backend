import { Router } from 'express';

import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  requirePermission,
  requirePlatformAdmin,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { AccountVoiceApiBody, VoiceAccountParams } from './voice-api.schema';
import {
  accountIvrs,
  adminVoiceStatus,
  providerIvrs,
  registerVoiceWebhook,
  setAccountVoiceApi,
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
  router.get('/voice-api/status', ...guard, async (_req, res) => {
    ok(res, await adminVoiceStatus());
  });
  router.post('/voice-api/webhook', ...guard, async (req, res) => {
    ok(res, await registerVoiceWebhook(req));
  });
  router.get('/voice-api/ivrs', ...guard, async (_req, res) => {
    ok(res, await providerIvrs(true));
  });
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
