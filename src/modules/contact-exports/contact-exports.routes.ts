import { Router } from 'express';

import type { StorageProvider } from '../../core/storage';
import { accepted, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { unavailableContactJobs, type ContactJobs } from '../contacts/jobs';

import { CreateExportBody, ExportIdParams, ListExportsQuery } from './contact-exports.schema';
import { createExport, getExport, listExports } from './contact-exports.service';

/** `/api/v1/contact-exports` — CSV exports (contacts leave the system: never while impersonating). */
export const createContactExportsRouter = ({
  storage,
  jobs = unavailableContactJobs,
}: { storage?: StorageProvider; jobs?: ContactJobs } = {}): Router => {
  const router = Router();
  router.use(authenticate(), requirePermission('contacts.export'), blockWhenImpersonating());
  router.post(
    '/',
    ...handle({ body: CreateExportBody }, async ({ body, req, res }) => {
      accepted(res, await createExport(req, body, jobs));
    }),
  );
  router.get(
    '/',
    ...handle({ query: ListExportsQuery }, async ({ query, req, res }) => {
      const page = await listExports(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get(
    '/:id',
    ...handle({ params: ExportIdParams }, async ({ params, req, res }) => {
      if (!storage) throw new Error('File storage is not configured');
      ok(res, await getExport(req, params.id, storage));
    }),
  );
  return router;
};
