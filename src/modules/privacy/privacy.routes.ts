import { Router } from 'express';

import type { StorageProvider } from '../../core/storage';
import { ProviderError } from '../../shared/errors/app-error';
import { accepted, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import type { ContactJobs } from '../contacts/jobs';

import { eraseContact, getEraseJob, startBulkErase } from './erase.service';
import { BulkEraseBody, EraseContactBody, EraseParams } from './privacy.schema';

/**
 * Contact erasure under `/api/v1/contacts`. Mounted before the contacts router, so each route
 * authenticates by itself: sessions only, never an API key, never while impersonating.
 */
export const createContactEraseRouter = ({
  storage,
  jobs,
}: {
  storage: StorageProvider | undefined;
  jobs: ContactJobs;
}): Router => {
  const router = Router();
  const guard = [authenticate(), requirePermission('contacts.erase'), blockWhenImpersonating()];
  router.post(
    '/bulk-erase',
    ...guard,
    ...handle({ body: BulkEraseBody }, async ({ body, req, res }) => {
      accepted(res, await startBulkErase(req, body.ids, jobs));
    }),
  );
  router.get(
    '/erase-jobs/:id',
    ...guard,
    ...handle({ params: EraseParams }, async ({ params, req, res }) => {
      ok(res, await getEraseJob(req, params.id));
    }),
  );
  router.post(
    '/:id/erase',
    ...guard,
    ...handle({ params: EraseParams, body: EraseContactBody }, async ({ params, req, res }) => {
      if (!storage) throw new ProviderError('PROVIDER_UNAVAILABLE');
      ok(res, await eraseContact(req, params.id, storage));
    }),
  );
  return router;
};
