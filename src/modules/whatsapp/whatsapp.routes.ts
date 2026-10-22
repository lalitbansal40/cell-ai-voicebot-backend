import { Router, type Request, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import { Types } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import type { WaActor } from './channel-status';
import type { WhatsAppContext } from './context';
import {
  ChannelParams,
  EmbeddedSignupBody,
  ListChannelsQuery,
  RegisterPinBody,
  RenameChannelBody,
} from './whatsapp.schema';
import type { WhatsAppService } from './whatsapp.service';

export interface WhatsAppRouterDeps {
  ctx: WhatsAppContext;
  service: WhatsAppService;
  /** `rl:wa-connect:` signups per account per hour (MemoryStore when omitted). */
  connectRateLimitStore?: Store;
}

/** The signed-in user as the channel actor. */
const actorOf = (req: Request): WaActor => {
  const auth = requireAuth(req);
  return {
    type: 'user',
    id: auth.userId ? new Types.ObjectId(auth.userId) : null,
    impersonatorId: auth.impersonatorId ? new Types.ObjectId(auth.impersonatorId) : null,
    ip: req.ip ?? null,
  };
};
const accountOf = (req: Request) => new Types.ObjectId(requireAuth(req).accountId);

/** Public Embedded Signup config for the browser (no secrets). */
export const whatsappConfig = (ctx: WhatsAppContext) => {
  const meta = ctx.env.META_PROVIDER === 'meta';
  return {
    enabled: ctx.env.WHATSAPP_ENABLED,
    provider: ctx.env.META_PROVIDER,
    appId: meta ? (ctx.env.META_APP_ID ?? null) : null,
    configId: meta ? (ctx.env.META_ES_CONFIG_ID ?? null) : null,
    graphVersion: ctx.env.META_GRAPH_VERSION,
  };
};

/** `/api/v1/whatsapp` when WhatsApp is off: every route 503 `WHATSAPP_NOT_CONFIGURED`. */
export const createWhatsAppDisabledRouter = (): Router => {
  const router = Router();
  router.use(authenticate());
  router.use(() => {
    throw new AppError('WHATSAPP_NOT_CONFIGURED');
  });
  return router;
};

/**
 * `/api/v1/whatsapp` (PHASE_9_PLAN §1n): numbers of the caller's account. Reads need
 * `whatsapp.read`; changes need `whatsapp.manage` (owners + admins), never while
 * impersonating; suspended accounts are read only (`authenticate`).
 */
export const createWhatsAppRouter = ({
  ctx,
  service,
  connectRateLimitStore,
}: WhatsAppRouterDeps): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('whatsapp.read');
  const manage = [
    requirePermission('whatsapp.manage'),
    blockWhenImpersonating(),
  ] as RequestHandler[];
  const connectLimit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: WHATSAPP_LIMITS.connectPerHourPerAccount,
    keyGenerator: (req) => `wa-connect:${req.auth?.accountId ?? 'anonymous'}`,
    ...(connectRateLimitStore ? { store: connectRateLimitStore } : {}),
  });

  router.get('/config', (_req, res) => {
    ok(res, whatsappConfig(ctx));
  });
  router.get(
    '/channels',
    read,
    ...handle({ query: ListChannelsQuery }, async ({ query, req, res }) => {
      ok(res, await service.listChannels(accountOf(req), query.status));
    }),
  );
  // static paths before `/:id`
  router.post(
    '/channels/embedded-signup',
    ...manage,
    connectLimit,
    ...handle({ body: EmbeddedSignupBody }, async ({ body, req, res }) => {
      ok(
        res,
        await service.connect({
          accountId: accountOf(req),
          actor: actorOf(req),
          mode: body.mode,
          code: body.code,
          sessionInfo: body.sessionInfo,
        }),
      );
    }),
  );
  router.get(
    '/channels/:id',
    read,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.getChannel(accountOf(req), params.id));
    }),
  );
  router.patch(
    '/channels/:id',
    ...manage,
    ...handle(
      { params: ChannelParams, body: RenameChannelBody },
      async ({ params, body, req, res }) => {
        ok(res, await service.rename(accountOf(req), params.id, body.label, actorOf(req)));
      },
    ),
  );
  router.post(
    '/channels/:id/sync',
    ...manage,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.sync(accountOf(req), params.id, actorOf(req)));
    }),
  );
  router.post(
    '/channels/:id/retry-setup',
    ...manage,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.retrySetup(accountOf(req), params.id, actorOf(req)));
    }),
  );
  router.post(
    '/channels/:id/register',
    ...manage,
    ...handle(
      { params: ChannelParams, body: RegisterPinBody },
      async ({ params, body, req, res }) => {
        ok(res, await service.submitPin(accountOf(req), params.id, body.pin, actorOf(req)));
      },
    ),
  );
  router.post(
    '/channels/:id/coexistence-sync',
    ...manage,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.retryCoexistenceSync(accountOf(req), params.id, actorOf(req)));
    }),
  );
  router.post(
    '/channels/:id/disconnect',
    ...manage,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.disconnect(accountOf(req), params.id, actorOf(req)));
    }),
  );
  return router;
};
