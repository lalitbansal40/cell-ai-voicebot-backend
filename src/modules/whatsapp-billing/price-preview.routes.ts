import { Router } from 'express';
import { Types } from 'mongoose';

import { requireAuth } from '../../shared/auth/auth-context';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { requireAnyPermission } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { PricePreviewBody } from './price-preview.schema';
import { pricePreview } from './price-preview.service';

/** `POST /api/v1/whatsapp/price-preview` — read-only price of one message (inbox / templates readers). */
export const createPricePreviewRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.post(
    '/price-preview',
    requireAnyPermission('inbox.read', 'templates.read'),
    ...handle({ body: PricePreviewBody }, async ({ body, req, res }) => {
      const auth = requireAuth(req);
      ok(res, await pricePreview(new Types.ObjectId(auth.accountId), body));
    }),
  );
  return router;
};
