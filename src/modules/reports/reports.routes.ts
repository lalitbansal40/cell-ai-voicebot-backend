import { Router } from 'express';

import { REPORT_LIMITS } from '../../config/limits';
import { tenantFilter } from '../../shared/auth/tenant';
import { getLogger } from '../../shared/logger';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { cachedReport, reportCacheKey, sha1, type ReportCacheStore } from './cache';
import { ReportParams, ReportQuery } from './reports.schema';
import { buildReport, reportContext } from './reports.service';

/** `/api/v1/reports/:tab` (Phase 14, `reports.read`). */
export const createReportsRouter = (deps: {
  cache: ReportCacheStore | null;
  now?: () => Date;
}): Router => {
  const router = Router();
  router.use(authenticate());
  router.get(
    '/:tab',
    requirePermission('reports.read'),
    ...handle({ params: ReportParams, query: ReportQuery }, async ({ params, query, req, res }) => {
      const started = Date.now();
      const now = deps.now?.() ?? new Date();
      const { accountId } = tenantFilter(req);
      const ctx = await reportContext(accountId, query, now);
      const key = reportCacheKey(accountId.toString(), params.tab, {
        from: ctx.from,
        to: ctx.to,
        previous: ctx.previous,
        slice: [ctx.slice.kind, ctx.slice.refId?.toString() ?? null],
        channels: ctx.callChannels,
        includeTest: ctx.includeTest,
        campaignIds: ctx.campaignIds.map(String),
      });
      const data = await cachedReport(deps.cache, key, () => buildReport(params.tab, ctx, now));
      const etag = `"${sha1(data)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, no-cache');
      const ms = Date.now() - started;
      if (ms > REPORT_LIMITS.slowReportMs)
        getLogger().warn({ tab: params.tab, ms }, 'reports: slow report');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.type('application/json').send(`{"success":true,"data":${data}}`);
    }),
  );
  return router;
};
