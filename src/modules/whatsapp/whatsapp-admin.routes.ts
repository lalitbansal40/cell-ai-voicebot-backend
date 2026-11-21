import { Router } from 'express';

import { AppError } from '../../shared/errors/app-error';
import { created, ok } from '../../shared/http/envelope';
import { blockWhenImpersonating } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { updateAccountWhatsAppBilling } from '../whatsapp-billing/admin.service';

import {
  addManagedNumber,
  adminDisconnect,
  confirmCreditLine,
  fixChannelWebhook,
  listEvents,
  manualConnect,
  replaceManagedKey,
  replayEvent,
  resetManagedWebhook,
  setManagedCreditLine,
  type WhatsAppAdminDeps,
  updateWhatsAppSolutionId,
  whatsappStatus,
  checkChannelMetaCalling,
  disableChannelMetaCalling,
  enableChannelMetaCalling,
} from './whatsapp-admin.service';
import {
  AdminDisconnectBody,
  ChannelParams,
  ConfirmCreditLineBody,
  EventParams,
  ListEventsQuery,
  ManagedCreditLineBody,
  ManagedKeyBody,
  ManagedNumberBody,
  ManualConnectBody,
  WhatsAppBillingBody,
  WhatsAppSolutionIdBody,
  MetaCallingBody,
  MetaCallingOffBody,
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
  router.patch(
    '/whatsapp/solution-id',
    blockWhenImpersonating(),
    ...handle({ body: WhatsAppSolutionIdBody }, async ({ body, req, res }) => {
      ok(res, await updateWhatsAppSolutionId(req, body.solutionId));
    }),
  );
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
  // PN: managed numbers over the Pinnacle partner API (superadmin, never while impersonating)
  const needPinnacle = (): WhatsAppAdminDeps => {
    const deps = need();
    if (!deps.ctx.env.PINNACLE_ENABLED || !deps.ctx.pinnacle) {
      throw new AppError('WA_PROVIDER_NOT_CONFIGURED');
    }
    return deps;
  };
  router.post(
    '/accounts/:id/whatsapp/managed-numbers',
    blockWhenImpersonating(),
    ...handle(
      { params: ChannelParams, body: ManagedNumberBody },
      async ({ params, body, req, res }) => {
        created(res, await addManagedNumber(req, needPinnacle(), params.id, body));
      },
    ),
  );
  router.post(
    '/whatsapp/channels/:id/managed/api-key',
    blockWhenImpersonating(),
    ...handle(
      { params: ChannelParams, body: ManagedKeyBody },
      async ({ params, body, req, res }) => {
        ok(res, await replaceManagedKey(req, needPinnacle(), params.id, body.apiKey));
      },
    ),
  );
  // PMC: calls of a managed number over Meta Graph (any account; a System User token allowed)
  router.post(
    '/whatsapp/channels/:id/meta-calling',
    blockWhenImpersonating(),
    ...handle(
      { params: ChannelParams, body: MetaCallingBody },
      async ({ params, body, req, res }) => {
        ok(res, await enableChannelMetaCalling(req, need(), params.id, body));
      },
    ),
  );
  router.delete(
    '/whatsapp/channels/:id/meta-calling',
    blockWhenImpersonating(),
    ...handle(
      { params: ChannelParams, body: MetaCallingOffBody },
      async ({ params, body, req, res }) => {
        ok(res, await disableChannelMetaCalling(req, need(), params.id, body));
      },
    ),
  );
  router.post(
    '/whatsapp/channels/:id/meta-calling/check',
    blockWhenImpersonating(),
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await checkChannelMetaCalling(req, need(), params.id));
    }),
  );
  // SAC-T4: Webhook check / Fix for a Meta number of any account
  router.post(
    '/whatsapp/channels/:id/webhook/fix',
    blockWhenImpersonating(),
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await fixChannelWebhook(req, need(), params.id));
    }),
  );
  router.post(
    '/whatsapp/channels/:id/managed/webhook',
    blockWhenImpersonating(),
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await resetManagedWebhook(req, needPinnacle(), params.id));
    }),
  );
  router.post(
    '/whatsapp/channels/:id/managed/credit-line',
    blockWhenImpersonating(),
    ...handle(
      { params: ChannelParams, body: ManagedCreditLineBody },
      async ({ params, body, req, res }) => {
        ok(res, await setManagedCreditLine(req, needPinnacle(), params.id, body.status));
      },
    ),
  );
  router.post(
    '/whatsapp/channels/:id/credit-line/confirm',
    blockWhenImpersonating(),
    ...handle(
      { params: ChannelParams, body: ConfirmCreditLineBody },
      async ({ params, body, req, res }) => {
        ok(res, await confirmCreditLine(req, need(), params.id, body.confirmed));
      },
    ),
  );
  return router;
};
