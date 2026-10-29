import { Router } from 'express';

import { created, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { blockWhenImpersonating } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import type { InboxContext } from '../inbox/context';

import { MessageIdParams, SendTemplateApiBody, SendTextApiBody } from './messages.schema';
import { getApiMessage, sendTemplateMessage, sendTextMessage } from './messages.service';

/**
 * `/api/v1/messages` — WhatsApp sends for outside systems (and the dashboard): the
 * inbox send path, `Idempotency-Key` required, `origin: 'api'` for keys.
 */
export const createMessagesRouter = (ix: () => InboxContext): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  const send = [
    access({ permission: 'inbox.reply', scope: 'messages:write' }),
    blockWhenImpersonating(),
    idempotency({ scope: (req) => req.auth?.accountId }),
  ];
  router.post(
    '/template',
    ...send,
    ...handle({ body: SendTemplateApiBody }, async ({ body, req, res }) => {
      const r = await sendTemplateMessage(ix(), req, body);
      if (r.created) created(res, r.message);
      else ok(res, r.message);
    }),
  );
  router.post(
    '/text',
    ...send,
    ...handle({ body: SendTextApiBody }, async ({ body, req, res }) => {
      const r = await sendTextMessage(ix(), req, body);
      if (r.created) created(res, r.message);
      else ok(res, r.message);
    }),
  );
  router.get(
    '/:id',
    access({ permission: 'inbox.read', scope: 'messages:read' }),
    ...handle({ params: MessageIdParams }, async ({ params, req, res }) => {
      ok(res, await getApiMessage(req, params.id));
    }),
  );
  return router;
};
