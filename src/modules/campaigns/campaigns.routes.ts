import { Router, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import { accepted, created, noContent, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  AudiencePreviewBody,
  CampaignParams,
  CancelCampaignBody,
  CreateCampaignBody,
  ExportCampaignBody,
  ListCampaignContactsQuery,
  ListCampaignsQuery,
  UpdateCampaignBody,
} from './campaigns.schema';
import {
  cancelCampaign,
  createCampaign,
  deleteCampaign,
  duplicateCampaign,
  estimateCampaignCost,
  getCampaign,
  listCampaignContacts,
  listCampaignRuns,
  listCampaigns,
  pauseCampaign,
  previewCampaignAudience,
  resumeCampaign,
  startCampaign,
  unscheduleCampaign,
  updateCampaign,
} from './campaigns.service';
import {
  createCampaignExport,
  unavailableCampaignExports,
  type CampaignExportJobs,
} from './export';
import { campaignSummary } from './summary';

export interface CampaignsRouterDeps {
  exports?: CampaignExportJobs;
  /** `rl:campaign:` writes per user per minute. */
  rateLimitStore?: Store;
}

/** `/api/v1/campaigns` — campaigns, their contacts, runs and exports (PHASE_8_PLAN §1r). */
export const createCampaignsRouter = ({
  exports = unavailableCampaignExports,
  rateLimitStore,
}: CampaignsRouterDeps = {}): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  const writes = createRateLimiter({
    windowMs: 60_000,
    limit: CAMPAIGN_LIMITS.writesPerMinutePerUser,
    keyGenerator: (req) => `campaign:${req.auth?.userId ?? req.auth?.apiKeyId ?? 'anonymous'}`,
    ...(rateLimitStore ? { store: rateLimitStore } : {}),
  });
  const read = requirePermission('campaigns.read');
  // public API (ADR 0045): a key with the scope instead of the permission
  const apiRead = access({ permission: 'campaigns.read', scope: 'campaigns:read' });
  const api = (permission: 'campaigns.write' | 'campaigns.run') =>
    [
      access({ permission, scope: 'campaigns:write' }),
      blockWhenImpersonating(),
      writes,
    ] as RequestHandler[];
  // impersonators look, never change (PHASE_8_PLAN §1q)
  const as = (permission: 'campaigns.write' | 'campaigns.run' | 'campaigns.export') =>
    [requirePermission(permission), blockWhenImpersonating(), writes] as RequestHandler[];
  const accountScope = (req: { auth?: { accountId: string } }) => req.auth?.accountId;

  // before `/:id`
  router.get(
    '/summary',
    read,
    ...handle({}, async ({ req, res }) => {
      ok(res, await campaignSummary(req));
    }),
  );
  router.get(
    '/',
    apiRead,
    ...handle({ query: ListCampaignsQuery }, async ({ query, req, res }) => {
      const page = await listCampaigns(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.post(
    '/',
    ...api('campaigns.write'),
    ...handle({ body: CreateCampaignBody }, async ({ body, req, res }) => {
      created(res, await createCampaign(req, body));
    }),
  );
  // static paths before /:id
  router.post(
    '/audience/preview',
    read,
    ...handle({ body: AudiencePreviewBody }, async ({ body, req, res }) => {
      ok(res, await previewCampaignAudience(req, body));
    }),
  );
  router.get(
    '/:id',
    apiRead,
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      ok(res, await getCampaign(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    ...as('campaigns.write'),
    ...handle(
      { params: CampaignParams, body: UpdateCampaignBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateCampaign(req, params.id, body));
      },
    ),
  );
  router.delete(
    '/:id',
    ...as('campaigns.write'),
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      await deleteCampaign(req, params.id);
      noContent(res);
    }),
  );
  router.post(
    '/:id/duplicate',
    ...as('campaigns.write'),
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      created(res, await duplicateCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/estimate',
    read,
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      ok(res, await estimateCampaignCost(req, params.id));
    }),
  );
  router.post(
    '/:id/start',
    ...api('campaigns.run'),
    idempotency({ scope: accountScope }),
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      ok(res, await startCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/unschedule',
    ...as('campaigns.run'),
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      ok(res, await unscheduleCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/pause',
    ...api('campaigns.run'),
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      ok(res, await pauseCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/resume',
    ...api('campaigns.run'),
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      ok(res, await resumeCampaign(req, params.id));
    }),
  );
  router.post(
    '/:id/cancel',
    ...api('campaigns.run'),
    ...handle(
      { params: CampaignParams, body: CancelCampaignBody },
      async ({ params, body, req, res }) => {
        ok(res, await cancelCampaign(req, params.id, body.hangUpLive));
      },
    ),
  );
  router.get(
    '/:id/contacts',
    apiRead,
    ...handle(
      { params: CampaignParams, query: ListCampaignContactsQuery },
      async ({ params, query, req, res }) => {
        const page = await listCampaignContacts(req, params.id, query);
        ok(res, page.items, page.meta);
      },
    ),
  );
  router.get(
    '/:id/runs',
    apiRead,
    ...handle({ params: CampaignParams }, async ({ params, req, res }) => {
      ok(res, (await listCampaignRuns(req, params.id)).items);
    }),
  );
  router.post(
    '/:id/export',
    ...as('campaigns.export'),
    ...handle(
      { params: CampaignParams, body: ExportCampaignBody },
      async ({ params, body, req, res }) => {
        accepted(res, await createCampaignExport(req, params.id, body.format, exports));
      },
    ),
  );
  return router;
};
