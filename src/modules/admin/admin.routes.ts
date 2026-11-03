import { Router } from 'express';

import { getEnv, type Env } from '../../config/env';
import type { AiProvider } from '../../core/ai/types';
import { getAppRedis } from '../../core/queues/redis';
import type { StorageProvider } from '../../core/storage';
import { ProviderError } from '../../shared/errors/app-error';
import { created, noContent, ok } from '../../shared/http/envelope';
import { getLogger } from '../../shared/logger';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import { requirePlatformAdmin } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { requireFreshMfa } from '../auth/mfa.service';
import { createWhatsAppAdminRouter } from '../whatsapp/whatsapp-admin.routes';
import type { WhatsAppAdminDeps } from '../whatsapp/whatsapp-admin.service';
import { createWhatsAppBillingAdminRouter } from '../whatsapp-billing/admin.routes';

import { createAdminAiRouter } from './admin-ai.routes';
import { createAdminBillingRouter } from './admin-billing.routes';
import {
  AccountCampaignParams,
  AccountIdParams,
  AccountLimitsBody,
  ApiLimitsBody,
  CreateAccountBody,
  SetOwnerPasswordBody,
  ListAccountsQuery,
  RetentionCapBody,
  SuspendBody,
} from './admin.schema';
import {
  accountDetail,
  adminCancelDeletion,
  adminRunDeletion,
  listAccountDeletions,
  createAccount,
  enableAccount,
  impersonate,
  listAccounts,
  pauseAllCampaigns,
  resumeAdminPaused,
  setAccountApiLimits,
  setAccountLimits,
  setOwnerPassword,
  setRetentionCap,
  stopImpersonation,
  suspendAccount,
} from './admin.service';
import { createSystemStatus } from './system.service';

/** `/api/v1/admin` — platform superadmin only. */
export const createAdminRouter = ({
  env,
  provider,
  whatsapp,
  storage,
}: {
  env: Pick<Env, 'BILLING_SIMULATOR_ENABLED' | 'PAYMENT_PROVIDER' | 'MFA_ENFORCED_FOR_ADMINS'> &
    Parameters<typeof createAdminAiRouter>[0]['env'];
  provider: Pick<AiProvider, 'name'>;
  /** Phase 9: WhatsApp runtime (superadmin WhatsApp tools); absent when WhatsApp is off. */
  whatsapp?: WhatsAppAdminDeps | undefined;
  /** Phase 16: an account purge removes files. */
  storage?: StorageProvider | undefined;
}): Router => {
  const router = Router();
  router.use(authenticate());

  // Uses the impersonation token, so it is NOT behind requirePlatformAdmin.
  router.post('/impersonation/stop', async (req, res) => {
    await stopImpersonation(req);
    noContent(res);
  });

  router.use(requirePlatformAdmin());
  const fresh = requireFreshMfa(env.MFA_ENFORCED_FOR_ADMINS);

  // Phase 17: Admin → System (created on first use: it opens read-only queue handles)
  let system: ReturnType<typeof createSystemStatus> | undefined;
  router.get('/system', async (_req, res) => {
    const current = getEnv();
    system ??= createSystemStatus({
      env: current,
      build: { commit: current.GIT_SHA ?? 'unknown', builtAt: current.BUILT_AT ?? 'unknown' },
      redis: getAppRedis(current.REDIS_URL, getLogger()),
    });
    ok(res, await system.read());
  });
  const createAccountLimit = createRateLimiter({ windowMs: 60 * 60 * 1000, limit: 60 });
  router.get(
    '/accounts',
    ...handle({ query: ListAccountsQuery }, async ({ query, res }) => {
      const { items, meta } = await listAccounts(query);
      ok(res, items, meta);
    }),
  );
  router.post(
    '/accounts',
    createAccountLimit,
    fresh,
    ...handle({ body: CreateAccountBody }, async ({ body, req, res }) => {
      created(res, await createAccount(req, body));
    }),
  );
  router.patch(
    '/accounts/:id/api-limits',
    ...handle(
      { params: AccountIdParams, body: ApiLimitsBody },
      async ({ params, body, req, res }) => {
        ok(res, await setAccountApiLimits(req, params.id, body.apiLimits));
      },
    ),
  );
  router.get('/account-deletions', async (_req, res) => {
    ok(res, await listAccountDeletions());
  });
  router.post(
    '/accounts/:id/deletion/cancel',
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      ok(res, await adminCancelDeletion(req, params.id));
    }),
  );
  router.post(
    '/accounts/:id/deletion/run',
    fresh,
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      if (!storage) throw new ProviderError('PROVIDER_UNAVAILABLE');
      ok(res, await adminRunDeletion(req, params.id, { storage }));
    }),
  );
  router.post(
    '/accounts/:id/owner-password',
    ...handle(
      { params: AccountIdParams, body: SetOwnerPasswordBody },
      async ({ params, body, req, res }) => {
        await setOwnerPassword(req, params.id, body.password);
        noContent(res);
      },
    ),
  );
  router.get(
    '/accounts/:id',
    ...handle({ params: AccountIdParams }, async ({ params, res }) => {
      ok(res, await accountDetail(params.id));
    }),
  );
  router.post(
    '/accounts/:id/suspend',
    ...handle(
      { params: AccountIdParams, body: SuspendBody },
      async ({ params, body, req, res }) => {
        ok(res, await suspendAccount(req, params.id, body.reason));
      },
    ),
  );
  router.post(
    '/accounts/:id/enable',
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      ok(res, await enableAccount(req, params.id));
    }),
  );
  router.patch(
    '/accounts/:id/limits',
    ...handle(
      { params: AccountIdParams, body: AccountLimitsBody },
      async ({ params, body, req, res }) => {
        ok(res, await setAccountLimits(req, params.id, body));
      },
    ),
  );
  router.put(
    '/accounts/:id/retention-cap',
    ...handle(
      { params: AccountIdParams, body: RetentionCapBody },
      async ({ params, body, req, res }) => {
        ok(res, await setRetentionCap(req, params.id, body));
      },
    ),
  );
  router.post(
    '/accounts/:id/campaigns/pause',
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      ok(res, await pauseAllCampaigns(req, params.id));
    }),
  );
  router.post(
    '/accounts/:id/campaigns/:campaignId/resume',
    ...handle({ params: AccountCampaignParams }, async ({ params, req, res }) => {
      ok(res, await resumeAdminPaused(req, params.id, params.campaignId));
    }),
  );
  router.post(
    '/accounts/:id/impersonate',
    fresh,
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      res.set('Cache-Control', 'no-store');
      ok(res, await impersonate(req, params.id));
    }),
  );
  router.use(createAdminBillingRouter({ env }));
  router.use(createAdminAiRouter({ env, provider }));
  router.use(createWhatsAppAdminRouter({ whatsapp }));
  router.use(createWhatsAppBillingAdminRouter());
  return router;
};
