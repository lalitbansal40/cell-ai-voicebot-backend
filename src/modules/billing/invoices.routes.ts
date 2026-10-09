import { Router } from 'express';

import type { StorageProvider } from '../../core/storage';
import { tenantFilter } from '../../shared/auth/tenant';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { InvoiceIdParams, ListInvoicesQuery } from './invoices.schema';
import { getInvoice, invoiceDownload, listInvoices } from './invoices.service';

/** `/api/v1/invoices` — GST invoices of paid top-ups (wallet.read). */
export const createInvoicesRouter = ({ storage }: { storage?: StorageProvider } = {}): Router => {
  const router = Router();
  router.use(authenticate(), requirePermission('wallet.read'));
  router.get(
    '/',
    ...handle({ query: ListInvoicesQuery }, async ({ query, req, res }) => {
      const page = await listInvoices(tenantFilter(req).accountId, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get(
    '/:id',
    ...handle({ params: InvoiceIdParams }, async ({ params, req, res }) => {
      ok(res, await getInvoice(tenantFilter(req).accountId, params.id));
    }),
  );
  router.get(
    '/:id/download',
    ...handle({ params: InvoiceIdParams }, async ({ params, req, res }) => {
      ok(res, await invoiceDownload(tenantFilter(req).accountId, params.id, storage));
    }),
  );
  return router;
};
