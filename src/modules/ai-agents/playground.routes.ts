import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import { AI_LIMITS } from '../../config/limits';
import { created, ok } from '../../shared/http/envelope';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  CreateSessionBody,
  ListSessionsQuery,
  PlaygroundAgentParams,
  PlaygroundSessionParams,
  SendMessageBody,
} from './playground.schema';
import {
  createSession,
  getSession,
  listSessions,
  resetSession,
  sendMessage,
  type PlaygroundDeps,
} from './playground.service';

/**
 * `/api/v1/agents/:id/playground/sessions` — test conversations. Running the
 * playground costs money: agents.write and never while impersonating.
 */
export const createPlaygroundRouter = (
  deps: PlaygroundDeps & { messagesStore?: Store },
): Router => {
  const router = Router({ mergeParams: true });
  const read = requirePermission('agents.read');
  const write = [requirePermission('agents.write'), blockWhenImpersonating()];
  const limiter = createRateLimiter({
    windowMs: 60_000,
    limit: AI_LIMITS.playgroundPerMinute,
    keyGenerator: (req) => `playground:${req.auth?.userId ?? 'anonymous'}`,
    ...(deps.messagesStore ? { store: deps.messagesStore } : {}),
  });

  router.post(
    '/',
    ...write,
    ...handle(
      { params: PlaygroundAgentParams, body: CreateSessionBody },
      async ({ params, body, req, res }) => {
        created(res, await createSession(req, params.id, body, deps));
      },
    ),
  );
  router.get(
    '/',
    read,
    ...handle(
      { params: PlaygroundAgentParams, query: ListSessionsQuery },
      async ({ params, query, req, res }) => {
        ok(res, await listSessions(req, params.id, query));
      },
    ),
  );
  router.get(
    '/:sid',
    read,
    ...handle({ params: PlaygroundSessionParams }, async ({ params, req, res }) => {
      ok(res, await getSession(req, params.id, params.sid));
    }),
  );
  router.post(
    '/:sid/messages',
    ...write,
    limiter,
    ...handle(
      { params: PlaygroundSessionParams, body: SendMessageBody },
      async ({ params, body, req, res }) => {
        ok(res, await sendMessage(req, params.id, params.sid, body, deps));
      },
    ),
  );
  router.post(
    '/:sid/reset',
    ...write,
    ...handle({ params: PlaygroundSessionParams }, async ({ params, req, res }) => {
      created(res, await resetSession(req, params.id, params.sid, deps));
    }),
  );
  return router;
};
