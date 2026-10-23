import { Router } from 'express';

import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { handle } from '../../shared/middlewares/validate';
import { updateAccountWhatsAppBilling } from '../whatsapp-billing/admin.service';

import {
  adminDisconnect,
  listEvents,
  manualConnect,
  replayEvent,
  whatsappStatus,
  type WhatsAppAdminDeps,
} from './whatsapp-admin.service';
import {
  AdminDisconnectBody,
  ChannelParams,
  EventParams,
  ListEventsQuery,
  ManualConnectBody,
  WhatsAppBillingBody,
} from './whatsapp.schema';

/**
 * Superadmin WhatsApp tools, mounted inside `/api/v1/admin` (already behind
 * `requirePlatformAdmin`). Actions on Meta need the WhatsApp runtime — without it
 * (WhatsApp off) they answer 503 `WHATSAPP_NOT_CONFIGURED`.
 */
export const createWhatsAppAdminRouter = ({
  whatsapp,
}: {
  whatsapp?: WhatsAppAdminDeps | undefined;
}): Router => {
  const router = Router();
  const need = (): WhatsAppAdminDeps => {
    if (!whatsapp?.ctx.env.WHATSAPP_ENABLED) throw new AppError('WHATSAPP_NOT_CONFIGURED');
    return whatsapp;
  };

  router.get('/whatsapp/status', async (_req, res) => {
    ok(res, await whatsappStatus(need().ctx.env));
  });
  router.get(
    '/whatsapp/events',
    ...handle({ query: ListEventsQuery }, async ({ query, res }) => {
      ok(res, await listEvents(query));
    }),
  );
  router.post(
    '/whatsapp/events/:id/replay',
    ...handle({ params: EventParams }, async ({ params, req, res }) => {
      ok(res, await replayEvent(req, need(), params.id));
    }),
  );
  router.post(
    '/whatsapp/channels/:id/disconnect',
    ...handle(
      { params: ChannelParams, body: AdminDisconnectBody },
      async ({ params, body, req, res }) => {
        ok(res, await adminDisconnect(req, need(), params.id, body.reason));
      },
    ),
  );
  router.patch(
    '/accounts/:id/whatsapp-billing',
    ...handle(
      { params: ChannelParams, body: WhatsAppBillingBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateAccountWhatsAppBilling(req, params.id, body));
      },
    ),
  );
  router.post(
    '/accounts/:id/whatsapp/manual-connect',
    ...handle(
      { params: ChannelParams, body: ManualConnectBody },
      async ({ params, body, req, res }) => {
        ok(res, await manualConnect(req, need(), params.id, body));
      },
    ),
  );
  return router;
};
