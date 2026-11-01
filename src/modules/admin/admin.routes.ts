import { Router } from 'express';

import type { Env } from '../../config/env';
import type { AiProvider } from '../../core/ai/types';
import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePlatformAdmin } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { createWhatsAppAdminRouter } from '../whatsapp/whatsapp-admin.routes';
import type { WhatsAppAdminDeps } from '../whatsapp/whatsapp-admin.service';
import { createWhatsAppBillingAdminRouter } from '../whatsapp-billing/admin.routes';

import { createAdminAiRouter } from './admin-ai.routes';
import { createAdminBillingRouter } from './admin-billing.routes';
import {
  AccountCampaignParams,
  AccountIdParams,
  AccountLimitsBody,
  CreateAccountBody,
  ListAccountsQuery,
  RetentionCapBody,
  SuspendBody,
} from './admin.schema';
import {
  accountDetail,
  createAccount,
  enableAccount,
  impersonate,
  listAccounts,
  pauseAllCampaigns,
  resendOwnerInvite,
  resumeAdminPaused,
  setAccountLimits,
  setRetentionCap,
  stopImpersonation,
  suspendAccount,
} from './admin.service';

/** `/api/v1/admin` — platform superadmin only. */
export const createAdminRouter = ({
  env,
  provider,
  whatsapp,
}: {
  env: Pick<Env, 'BILLING_SIMULATOR_ENABLED' | 'PAYMENT_PROVIDER'> &
    Parameters<typeof createAdminAiRouter>[0]['env'];
  provider: Pick<AiProvider, 'name'>;
  /** Phase 9: WhatsApp runtime (superadmin WhatsApp tools); absent when WhatsApp is off. */
  whatsapp?: WhatsAppAdminDeps | undefined;
}): Router => {
  const router = Router();
  router.use(authenticate());

  // Uses the impersonation token, so it is NOT behind requirePlatformAdmin.
  router.post('/impersonation/stop', async (req, res) => {
    await stopImpersonation(req);
    noContent(res);
  });

  router.use(requirePlatformAdmin());
  router.get(
    '/accounts',
    ...handle({ query: ListAccountsQuery }, async ({ query, res }) => {
      const { items, meta } = await listAccounts(query);
      ok(res, items, meta);
    }),
  );
  router.post(
    '/accounts',
    ...handle({ body: CreateAccountBody }, async ({ body, req, res }) => {
      created(res, await createAccount(req, body));
    }),
  );
  router.post(
    '/accounts/:id/resend-owner-invite',
    ...handle({ params: AccountIdParams }, async ({ params, req, res }) => {
      await resendOwnerInvite(req, params.id);
      noContent(res);
    }),
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
