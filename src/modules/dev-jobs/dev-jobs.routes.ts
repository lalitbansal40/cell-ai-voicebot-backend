import { Router } from 'express';

import { getEnv } from '../../config/env';
import type { StorageProvider } from '../../core/storage';
import { ok } from '../../shared/http/envelope';
import { getLogger } from '../../shared/logger';
import { handle } from '../../shared/middlewares/validate';
import { z } from '../../shared/openapi/zod';
import { purgeCalls } from '../calls/maintenance';
import { runInboxRetention } from '../inbox/retention.job';
import { sendDueReports } from '../report-subscriptions/report-subscriptions.service';

export const DEV_JOBS = ['calls-purge', 'inbox-retention', 'reports-email'] as const;

const Params = z.strictObject({ name: z.enum(DEV_JOBS) });
/** Runs the job as if it were `daysAhead` days (and `hoursAhead` hours) later. */
const Body = z.strictObject({
  daysAhead: z.number().int().min(0).max(400).default(0),
  hoursAhead: z.number().int().min(0).max(23).default(0),
});

/**
 * `/api/v1/dev/jobs/:name` — DEV / E2E ONLY (Phase 14): runs a nightly / hourly job now,
 * optionally "later" so retention and report periods can be checked end to end. No
 * auth, like `/mock`; mounted only with `MOCK_APIS_ENABLED` outside production.
 */
export const createDevJobsRouter = ({ storage }: { storage?: StorageProvider } = {}): Router => {
  const router = Router();
  router.post(
    '/:name',
    ...handle({ params: Params, body: Body }, async ({ params, body, res }) => {
      const env = getEnv();
      const now = new Date(Date.now() + (body.daysAhead * 24 + body.hoursAhead) * 3_600_000);
      switch (params.name) {
        case 'calls-purge':
          ok(res, await purgeCalls(storage, env.CALL_RETENTION_DAYS, now));
          return;
        case 'inbox-retention':
          if (!storage) throw new Error('File storage is not configured');
          ok(res, { ...(await runInboxRetention(storage, env.INBOX_RETENTION_DAYS, now)) });
          return;
        case 'reports-email':
          ok(
            res,
            await sendDueReports({
              appUrl: env.FRONTEND_URL,
              apiUrl: env.APP_URL,
              logger: getLogger(),
              now: () => now,
            }),
          );
          return;
      }
    }),
  );
  return router;
};
