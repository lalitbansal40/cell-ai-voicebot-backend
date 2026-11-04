import { Router } from 'express';

import type { StorageProvider } from '../../core/storage';
import { ProviderError } from '../../shared/errors/app-error';
import { accepted, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockSensitiveWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import type { ContactJobs } from '../contacts/jobs';

import { cancelAccountDelete, scheduleAccountDelete } from './account-delete.service';
import {
  getAccountExport,
  listAccountExports,
  requestAccountExport,
} from './account-export.service';
import { eraseContact, getEraseJob, startBulkErase } from './erase.service';
import {
  AccountDeleteBody,
  AccountExportBody,
  BulkEraseBody,
  EraseContactBody,
  EraseParams,
} from './privacy.schema';

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
  const guard = [
    authenticate(),
    requirePermission('contacts.erase'),
    blockSensitiveWhenImpersonating(),
  ];
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

/**
 * `/api/v1/account` export and delete: the owner only (the permissions), the password again,
 * sessions only, never while impersonating. A suspended account's owner can still use them.
 */
export const createAccountPrivacyRouter = ({
  storage,
  jobs,
}: {
  storage: StorageProvider | undefined;
  jobs: ContactJobs;
}): Router => {
  const router = Router();
  const auth = authenticate({ allowSuspended: true });
  const exporting = [auth, requirePermission('account.export'), blockSensitiveWhenImpersonating()];
  const deleting = [auth, requirePermission('account.delete'), blockSensitiveWhenImpersonating()];
  router.post(
    '/export',
    ...exporting,
    ...handle({ body: AccountExportBody }, async ({ body, req, res }) => {
      if (!storage) throw new ProviderError('PROVIDER_UNAVAILABLE');
      accepted(res, await requestAccountExport(req, body, jobs));
    }),
  );
  router.get('/exports', ...exporting, async (req, res) => {
    ok(res, await listAccountExports(req));
  });
  router.get(
    '/exports/:id',
    ...exporting,
    ...handle({ params: EraseParams }, async ({ params, req, res }) => {
      if (!storage) throw new ProviderError('PROVIDER_UNAVAILABLE');
      ok(res, await getAccountExport(req, params.id, storage));
    }),
  );
  router.post(
    '/delete',
    ...deleting,
    ...handle({ body: AccountDeleteBody }, async ({ body, req, res }) => {
      ok(res, await scheduleAccountDelete(req, body));
    }),
  );
  router.post('/delete/cancel', ...deleting, async (req, res) => {
    ok(res, await cancelAccountDelete(req));
  });
  return router;
};
