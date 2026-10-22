import { Router } from 'express';
import { Types } from 'mongoose';

import { requireAuth } from '../../shared/auth/auth-context';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { InboxSettingsPatchBody } from './inbox.schema';
import { getInboxSettings, updateInboxSettings } from './settings.service';

/** `/api/v1/account/inbox-settings` — read `account.read`, change `account.update` (owner / admin). */
export const createInboxSettingsRouter = (deps: { retentionDays: number }): Router => {
  const router = Router();
  router.use(authenticate());
  router.get('/', requirePermission('account.read'), async (req, res) => {
    ok(
      res,
      await getInboxSettings(new Types.ObjectId(requireAuth(req).accountId), deps.retentionDays),
    );
  });
  router.patch(
    '/',
    requirePermission('account.update'),
    blockWhenImpersonating(),
    ...handle({ body: InboxSettingsPatchBody }, async ({ body, req, res }) => {
      const auth = requireAuth(req);
      ok(
        res,
        await updateInboxSettings(
          {
            accountId: new Types.ObjectId(auth.accountId),
            actor: { type: 'user', id: auth.userId ?? null },
            ip: req.ip ?? null,
            retentionDays: deps.retentionDays,
          },
          body,
        ),
      );
    }),
  );
  return router;
};
