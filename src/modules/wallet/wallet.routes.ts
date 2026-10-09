import { Router } from 'express';

import { tenantFilter } from '../../shared/auth/tenant';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { exportLedger, getLedgerEntry, listLedger } from './ledger.service';
import { createTopupsRouter, type TopupRouterDeps } from './topups.routes';
import { getUsage } from './usage.service';
import {
  EstimateBody,
  LedgerExportQuery,
  LedgerIdParams,
  LedgerQuery,
  UsageQuery,
  WalletSettingsBody,
} from './wallet.schema';
import { estimate, getRates, getWallet, updateSettings } from './wallet.service';

/** `/api/v1/wallet` — balance, settings, prices, ledger, usage. */
export const createWalletRouter = (deps: TopupRouterDeps): Router => {
  const router = Router();
  router.use(authenticate());
  router.use('/topups', createTopupsRouter(deps));
  router.get(
    '/',
    requirePermission('wallet.read'),
    ...handle({}, async ({ req, res }) => {
      ok(res, await getWallet(req));
    }),
  );
  router.patch(
    '/settings',
    requirePermission('wallet.topup'),
    blockWhenImpersonating(),
    ...handle({ body: WalletSettingsBody }, async ({ body, req, res }) => {
      ok(res, await updateSettings(req, body));
    }),
  );
  router.get(
    '/rates',
    requirePermission('wallet.read'),
    ...handle({}, async ({ req, res }) => {
      ok(res, await getRates(req));
    }),
  );
  router.post(
    '/estimate',
    requirePermission('wallet.read'),
    ...handle({ body: EstimateBody }, async ({ body, req, res }) => {
      ok(res, await estimate(req, body));
    }),
  );
  router.get(
    '/ledger',
    requirePermission('wallet.read'),
    ...handle({ query: LedgerQuery }, async ({ query, req, res }) => {
      const page = await listLedger(tenantFilter(req).accountId, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get(
    '/ledger/export',
    requirePermission('wallet.read'),
    ...handle({ query: LedgerExportQuery }, async ({ query, req, res }) => {
      await exportLedger(req, res, query);
    }),
  );
  router.get(
    '/ledger/:id',
    requirePermission('wallet.read'),
    ...handle({ params: LedgerIdParams }, async ({ params, req, res }) => {
      ok(res, await getLedgerEntry(tenantFilter(req).accountId, params.id));
    }),
  );
  router.get(
    '/usage',
    requirePermission('wallet.read'),
    ...handle({ query: UsageQuery }, async ({ query, req, res }) => {
      ok(res, await getUsage(req, query));
    }),
  );
  return router;
};
