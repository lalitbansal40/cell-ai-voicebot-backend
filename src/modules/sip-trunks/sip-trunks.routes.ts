import { Router } from 'express';

import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requirePlatformAdmin } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { SipTrunkBody, SipTrunkParams } from './sip-trunks.schema';
import { getSipTrunk, removeSipTrunk, saveSipTrunk } from './sip-trunks.service';

/** `/api/v1/admin/accounts/:id/sip-trunk` — an account's own SIP trunk (superadmin). */
export const createSipTrunksRouter = (): Router => {
  const router = Router();
  const guard = [authenticate(), requirePlatformAdmin()];
  router.get(
    '/accounts/:id/sip-trunk',
    ...guard,
    ...handle({ params: SipTrunkParams }, async ({ params, res }) => {
      ok(res, await getSipTrunk(params.id));
    }),
  );
  router.put(
    '/accounts/:id/sip-trunk',
    ...guard,
    ...handle(
      { params: SipTrunkParams, body: SipTrunkBody },
      async ({ params, body, req, res }) => {
        ok(res, await saveSipTrunk(req, params.id, body));
      },
    ),
  );
  router.delete(
    '/accounts/:id/sip-trunk',
    ...guard,
    ...handle({ params: SipTrunkParams }, async ({ params, req, res }) => {
      ok(res, await removeSipTrunk(req, params.id));
    }),
  );
  return router;
};
