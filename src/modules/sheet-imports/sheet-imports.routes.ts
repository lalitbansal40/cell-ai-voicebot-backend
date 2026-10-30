import { Router } from 'express';

import type { Env } from '../../config/env';
import { accepted, created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { unavailableContactJobs, type ContactJobs } from '../contacts/jobs';

import { CreateSheetImportBody, PreviewSheetBody, SheetImportParams } from './sheet-imports.schema';
import {
  createSheetImport,
  deleteSheetImport,
  listSheetImports,
  previewSheet,
  runSheetImportNow,
} from './sheet-imports.service';

/** `/api/v1/sheet-imports` — scheduled Google-Sheet contact imports (dashboard only). */
export const createSheetImportsRouter = ({
  env,
  jobs = unavailableContactJobs,
}: {
  env: Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL'>;
  jobs?: ContactJobs;
}): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('contacts.import');
  const change = [read, blockWhenImpersonating()];
  router.get('/', read, async (req, res) => {
    ok(res, await listSheetImports(req));
  });
  router.post(
    '/',
    ...change,
    ...handle({ body: CreateSheetImportBody }, async ({ body, req, res }) => {
      created(res, await createSheetImport(env, jobs, req, body));
    }),
  );
  router.post(
    '/preview',
    read,
    ...handle({ body: PreviewSheetBody }, async ({ body, req, res }) => {
      ok(res, await previewSheet(env, req, body.url));
    }),
  );
  router.post(
    '/:id/run',
    ...change,
    ...handle({ params: SheetImportParams }, async ({ params, req, res }) => {
      accepted(res, await runSheetImportNow(jobs, req, params.id));
    }),
  );
  router.delete(
    '/:id',
    ...change,
    ...handle({ params: SheetImportParams }, async ({ params, req, res }) => {
      await deleteSheetImport(req, params.id);
      noContent(res);
    }),
  );
  return router;
};
