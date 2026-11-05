import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import type { StorageProvider } from '../../core/storage';
import { requireAuth } from '../../shared/auth/auth-context';
import { created, noContent, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import { blockWhenImpersonating } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  CampaignBody,
  CampaignIdParams,
  ListCampaignsQuery,
  RecipientsQuery,
} from './campaigns.schema';
import {
  campaignReport,
  createCampaign,
  deleteCampaign,
  estimateCampaign,
  exportRecipients,
  getCampaign,
  listCampaigns,
  listRecipients,
  pauseCampaign,
  resumeCampaign,
  retryFailed,
  startCampaign,
  stopCampaign,
  updateCampaign,
  type WaCampaignJobs,
} from './campaigns.service';

/** `/api/v1/whatsapp-campaigns` (Phase 19): bulk template sends, charged from the wallet. */
export const createWaCampaignsRouter = (
  deps: { jobs?: WaCampaignJobs; createStore?: Store; storage?: StorageProvider } = {},
): Router => {
  const router = Router();
  // DOCS-T3: a dashboard session needs the permission, an API key the scope
  router.use(authenticate({ apiKeys: true }));
  const read = access({ permission: 'whatsapp.campaigns.read', scope: 'whatsapp-campaigns:read' });
  const write = [
    access({ permission: 'whatsapp.campaigns.write', scope: 'whatsapp-campaigns:write' }),
    blockWhenImpersonating(),
  ];
  const scope = (req: { auth?: { accountId: string } }) => req.auth?.accountId;
  const createLimit = createRateLimiter({
    windowMs: 3_600_000,
    limit: 30,
    keyGenerator: (req) => `wa-campaign-create:${requireAuth(req).accountId}`,
    ...(deps.createStore ? { store: deps.createStore } : {}),
  });

  router.get(
    '/',
    read,
    ...handle({ query: ListCampaignsQuery }, async ({ req, res, query }) => {
      const page = await listCampaigns(req, query);
      ok(res, page.data, page.meta);
    }),
  );
  router.post(
    '/',
    ...write,
    createLimit,
    ...handle({ body: CampaignBody }, async ({ req, res, body }) => {
      created(res, await createCampaign(req, body, deps.storage));
    }),
  );
  router.get(
    '/:id',
    read,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await getCampaign(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    ...write,
    ...handle(
      { params: CampaignIdParams, body: CampaignBody },
      async ({ req, res, params, body }) => {
        ok(res, await updateCampaign(req, params.id, body, deps.storage));
      },
    ),
  );
  router.delete(
    '/:id',
    ...write,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      await deleteCampaign(req, params.id, deps.storage);
      noContent(res);
    }),
  );
  router.post(
    '/:id/estimate',
    read,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await estimateCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/start',
    ...write,
    idempotency({ scope }),
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await startCampaign(req, params.id, deps.jobs));
    }),
  );
  router.post(
    '/:id/pause',
    ...write,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await pauseCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/resume',
    ...write,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await resumeCampaign(req, params.id, deps.jobs));
    }),
  );
  router.post(
    '/:id/stop',
    ...write,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await stopCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/retry-failed',
    ...write,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await retryFailed(req, params.id, deps.jobs));
    }),
  );
  router.get(
    '/:id/recipients',
    read,
    ...handle(
      { params: CampaignIdParams, query: RecipientsQuery },
      async ({ req, res, params, query }) => {
        const page = await listRecipients(req, params.id, query);
        ok(res, page.data, page.meta);
      },
    ),
  );
  router.get(
    '/:id/export',
    read,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      res.set('Content-Type', 'text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="whatsapp-campaign-${params.id}.csv"`);
      res.send(await exportRecipients(req, params.id));
    }),
  );
  router.get(
    '/:id/report',
    read,
    ...handle({ params: CampaignIdParams }, async ({ req, res, params }) => {
      ok(res, await campaignReport(req, params.id));
    }),
  );
  return router;
};
