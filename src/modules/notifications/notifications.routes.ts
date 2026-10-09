import { Router } from 'express';
import { Types } from 'mongoose';

import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { ForbiddenError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { handle } from '../../shared/middlewares/validate';

import { ListNotificationsQuery, NotificationIdParams } from './notifications.schema';
import { listNotifications, markAllRead, markRead, unreadCount } from './notifications.service';

const me = (req: Parameters<typeof requireAuth>[0]) => {
  const auth = requireAuth(req);
  // API keys have no user → no personal notifications.
  if (!auth.userId) throw new ForbiddenError();
  return { accountId: tenantFilter(req).accountId, userId: new Types.ObjectId(auth.userId) };
};

/** `/api/v1/notifications` — every signed-in user's own notifications (the bell). */
export const createNotificationsRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.get(
    '/',
    ...handle({ query: ListNotificationsQuery }, async ({ query, req, res }) => {
      const { accountId, userId } = me(req);
      const page = await listNotifications(accountId, userId, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.get(
    '/unread-count',
    ...handle({}, async ({ req, res }) => {
      const { accountId, userId } = me(req);
      ok(res, { count: await unreadCount(accountId, userId) });
    }),
  );
  router.post(
    '/read-all',
    ...handle({}, async ({ req, res }) => {
      const { accountId, userId } = me(req);
      ok(res, await markAllRead(accountId, userId));
    }),
  );
  router.post(
    '/:id/read',
    ...handle({ params: NotificationIdParams }, async ({ params, req, res }) => {
      const { accountId, userId } = me(req);
      ok(res, await markRead(accountId, userId, params.id));
    }),
  );
  return router;
};
