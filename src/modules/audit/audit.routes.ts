import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { listAudit } from './audit.query';
import { ListAuditQuery } from './audit.schema';

export const createAuditRouter = (): Router => {
  const router = Router();
  router.get(
    '/',
    authenticate(),
    requirePermission('audit.read'),
    ...handle({ query: ListAuditQuery }, async ({ query, req, res }) => {
      const { items, meta } = await listAudit(req, query);
      ok(res, items, meta);
    }),
  );
  return router;
};
