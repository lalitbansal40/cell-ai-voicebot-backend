import { Router } from 'express';

import type { AiJobs } from '../../core/ai/jobs';
import { accepted, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { getChatSummaries, requestChatSummary } from './chat-summary.service';
import {
  DispositionBody,
  DispositionsBody,
  InsightParams,
  InsightsSettingsBody,
} from './insights.schema';
import {
  getDispositions,
  getInsights,
  getInsightsSettings,
  regenerateInsights,
  setDisposition,
  updateDispositions,
  updateInsightsSettings,
} from './insights.service';

/** `/api/v1/calls/:id/insights|disposition` (Phase 14). Mounted beside the calls router. */
export const createCallInsightsRouter = (deps: { jobs: AiJobs }): Router => {
  const router = Router();
  router.use(authenticate());
  router.get(
    '/:id/insights',
    requirePermission('calls.read'),
    ...handle({ params: InsightParams }, async ({ params, req, res }) => {
      ok(res, await getInsights(req, params.id));
    }),
  );
  router.post(
    '/:id/insights/regenerate',
    requirePermission('calls.listen'),
    blockWhenImpersonating(),
    ...handle({ params: InsightParams }, async ({ params, req, res }) => {
      accepted(res, await regenerateInsights(req, params.id, deps));
    }),
  );
  router.patch(
    '/:id/disposition',
    requirePermission('calls.trigger'),
    blockWhenImpersonating(),
    ...handle(
      { params: InsightParams, body: DispositionBody },
      async ({ params, body, req, res }) => {
        ok(res, await setDisposition(req, params.id, body.disposition));
      },
    ),
  );
  return router;
};

/** `/api/v1/inbox/conversations/:id/summary` (Phase 14). Mounted before the inbox router. */
export const createChatSummaryRouter = (deps: { jobs: AiJobs }): Router => {
  const router = Router();
  router.get(
    '/conversations/:id/summary',
    authenticate(),
    requirePermission('inbox.read'),
    ...handle({ params: InsightParams }, async ({ params, req, res }) => {
      ok(res, await getChatSummaries(req, params.id));
    }),
  );
  router.post(
    '/conversations/:id/summary',
    authenticate(),
    requirePermission('inbox.reply'),
    blockWhenImpersonating(),
    ...handle({ params: InsightParams }, async ({ params, req, res }) => {
      accepted(res, await requestChatSummary(req, params.id, deps));
    }),
  );
  return router;
};

/** `/api/v1/account/insights-settings|dispositions` (Phase 14). */
export const createAccountInsightsRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.get('/insights-settings', requirePermission('account.read'), async (req, res) => {
    ok(res, await getInsightsSettings(req));
  });
  router.put(
    '/insights-settings',
    requirePermission('account.update'),
    ...handle({ body: InsightsSettingsBody }, async ({ body, req, res }) => {
      ok(res, await updateInsightsSettings(req, body));
    }),
  );
  router.get('/dispositions', requirePermission('account.read'), async (req, res) => {
    ok(res, await getDispositions(req));
  });
  router.put(
    '/dispositions',
    requirePermission('account.update'),
    ...handle({ body: DispositionsBody }, async ({ body, req, res }) => {
      ok(res, await updateDispositions(req, body.dispositions));
    }),
  );
  return router;
};
