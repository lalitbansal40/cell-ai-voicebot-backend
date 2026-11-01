import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  requirePermission,
  requirePlatformAdmin,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { CeilingBody } from './compliance.schema';
import {
  complianceCsv,
  getCallingWindowCeiling,
  getCompliance,
  setCallingWindowCeiling,
} from './compliance.service';

/** `/api/v1/account/compliance`: read-only rules and the CSV of changes. */
export const createComplianceRouter = (): Router => {
  const router = Router();
  const guard = [authenticate(), requirePermission('account.read')];
  router.get('/compliance', ...guard, async (req, res) => {
    ok(res, await getCompliance(req));
  });
  router.get('/compliance/export', ...guard, async (req, res) => {
    const csv = await complianceCsv(req);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="compliance.csv"');
    res.send(`\ufeff${csv}`);
  });
  return router;
};

/** `/api/v1/admin/compliance/ceiling`: superadmin. */
export const createAdminComplianceRouter = (): Router => {
  const router = Router();
  const guard = [authenticate(), requirePlatformAdmin()];
  router.get('/compliance/ceiling', ...guard, async (_req, res) => {
    ok(res, await getCallingWindowCeiling());
  });
  router.put(
    '/compliance/ceiling',
    ...guard,
    ...handle({ body: CeilingBody }, async ({ body, req, res }) => {
      ok(res, await setCallingWindowCeiling(req, body));
    }),
  );
  return router;
};
