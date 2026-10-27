import { Router } from 'express';

import type { StorageProvider } from '../../core/storage';
import { accepted, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requireAnyPermission,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { unavailableContactJobs, type ContactJobs } from '../contacts/jobs';

import {
  ExportCallsBody,
  ExportMessagesBody,
  ExportParams,
  ExportReportBody,
  ListRecordExportsQuery,
} from './record-exports.schema';
import {
  createCallsExport,
  createMessagesExport,
  createReportExport,
  getRecordExport,
  listRecordExports,
} from './record-exports.service';

/** `/api/v1/exports` (Phase 14): records leave the system — never while impersonating. */
export const createRecordExportsRouter = ({
  storage,
  jobs = unavailableContactJobs,
}: { storage?: StorageProvider; jobs?: ContactJobs } = {}): Router => {
  const router = Router();
  router.use(authenticate(), blockWhenImpersonating());
  router.post(
    '/calls',
    requirePermission('calls.export'),
    ...handle({ body: ExportCallsBody }, async ({ body, req, res }) => {
      accepted(res, await createCallsExport(req, body, jobs));
    }),
  );
  router.post(
    '/messages',
    requirePermission('reports.export'),
    ...handle({ body: ExportMessagesBody }, async ({ body, req, res }) => {
      accepted(res, await createMessagesExport(req, body, jobs));
    }),
  );
  router.post(
    '/report',
    requirePermission('reports.export'),
    ...handle({ body: ExportReportBody }, async ({ body, req, res }) => {
      accepted(res, await createReportExport(req, body, jobs));
    }),
  );
  router.get(
    '/',
    requireAnyPermission('calls.export', 'reports.export'),
    ...handle({ query: ListRecordExportsQuery }, async ({ query, req, res }) => {
      const page = await listRecordExports(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get(
    '/:id',
    requireAnyPermission('calls.export', 'reports.export'),
    ...handle({ params: ExportParams }, async ({ params, req, res }) => {
      if (!storage) throw new Error('File storage is not configured');
      ok(res, await getRecordExport(req, params.id, storage));
    }),
  );
  return router;
};
