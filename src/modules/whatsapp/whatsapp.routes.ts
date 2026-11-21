import { Router, type Request, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import { Types } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { AccountModel, DEFAULT_ACCOUNT_WHATSAPP } from '../../db/models/account.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { isFullAccess } from '../../shared/auth/impersonation';
import { AppError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import { channelListItem } from './channel-json';
import type { WaActor } from './channel-status';
import type { WhatsAppContext } from './context';
import { getWhatsAppSolutionId } from './embedded-signup-config';
import {
  ChannelParams,
  EmbeddedSignupBody,
  ListChannelsQuery,
  RegisterPinBody,
  MetaCallingBody,
  MetaCallingOffBody,
  RenameChannelBody,
  SwitchToMetaBody,
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

/** Active Meta Facebook Login for Business configuration used by Embedded Signup. */
const EMBEDDED_SIGNUP_CONFIG_ID = '3076770379332692';

/** Public Embedded Signup config for the browser (no secrets). */
export const whatsappConfig = async (ctx: WhatsAppContext, accountId: Types.ObjectId) => {
  const meta = ctx.env.META_PROVIDER === 'meta';
  const [account, configuredSolutionId] = await Promise.all([
    AccountModel.findById(accountId).select({ 'whatsapp.metaPayer': 1 }).lean<{
      whatsapp?: { metaPayer?: 'platform' | 'customer' };
    }>(),
    meta ? getWhatsAppSolutionId() : Promise.resolve(null),
  ]);
  const metaPayer = account?.whatsapp?.metaPayer ?? DEFAULT_ACCOUNT_WHATSAPP.metaPayer;
  return {
    enabled: ctx.env.WHATSAPP_ENABLED,
    provider: ctx.env.META_PROVIDER,
    appId: meta ? (ctx.env.META_APP_ID ?? null) : null,
    configId: meta ? EMBEDDED_SIGNUP_CONFIG_ID : null,
    graphVersion: ctx.env.META_GRAPH_VERSION,
    metaPayer,
    solutionId: meta && metaPayer === 'platform' ? configuredSolutionId : null,
    /** PMC: "Calling on karo (Meta direct)" on managed numbers. */
    metaCallingEnabled: ctx.env.WA_META_CALLING_ENABLED,
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

  router.get('/config', async (req, res) => {
    ok(res, await whatsappConfig(ctx, accountOf(req)));
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
  // SAC-T11: a managed (partner) number moves to Meta direct
  router.post(
    '/channels/:id/switch-to-meta',
    ...manage,
    connectLimit,
    ...handle(
      { params: ChannelParams, body: SwitchToMetaBody },
      async ({ params, body, req, res }) => {
        ok(res, await service.switchToMeta(accountOf(req), params.id, body, actorOf(req)));
      },
    ),
  );
  // PMC: calls of a managed number over Meta Graph (messages stay on the partner)
  router.get(
    '/channels/:id/meta-calling',
    read,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.metaCallingStatus(accountOf(req), params.id));
    }),
  );
  router.post(
    '/channels/:id/meta-calling',
    ...manage,
    ...handle(
      { params: ChannelParams, body: MetaCallingBody },
      async ({ params, body, req, res }) => {
        const auth = requireAuth(req);
        // D15: a pasted token only from a superadmin in full access
        const allowToken =
          isFullAccess(auth) && (auth.impersonatorKind ?? 'superadmin') === 'superadmin';
        const r = await service.enableMetaCalling(accountOf(req), params.id, body, actorOf(req), {
          allowToken,
        });
        ok(res, { channel: channelListItem(r.channel), steps: r.steps });
      },
    ),
  );
  router.delete(
    '/channels/:id/meta-calling',
    ...manage,
    ...handle(
      { params: ChannelParams, body: MetaCallingOffBody },
      async ({ params, body, req, res }) => {
        const r = await service.disableMetaCalling(accountOf(req), params.id, body, actorOf(req));
        ok(res, {
          channel: channelListItem(r.channel),
          turnedOffAtWhatsApp: r.turnedOffAtWhatsApp,
          unsubscribed: r.unsubscribed,
        });
      },
    ),
  );
  router.post(
    '/channels/:id/meta-calling/check',
    ...manage,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      const r = await service.checkMetaCalling(accountOf(req), params.id, actorOf(req));
      ok(res, { channel: channelListItem(r.channel), steps: r.steps });
    }),
  );
  // SAC-T4: Webhook check / Fix
  router.get(
    '/channels/:id/webhook',
    requirePermission('whatsapp.read'),
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.webhookStatus(accountOf(req), params.id));
    }),
  );
  router.post(
    '/channels/:id/webhook/fix',
    ...manage,
    ...handle({ params: ChannelParams }, async ({ params, req, res }) => {
      ok(res, await service.fixWebhook(accountOf(req), params.id, actorOf(req)));
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
