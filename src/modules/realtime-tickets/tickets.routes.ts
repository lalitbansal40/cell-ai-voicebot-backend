import { Router } from 'express';

import { getEnv } from '../../config/env';
import { getAppRedis } from '../../core/queues/redis';
import { tryGetRealtime, WsTicketService } from '../../core/realtime';
import { requireAuth } from '../../shared/auth/auth-context';
import { created } from '../../shared/http/envelope';
import { getLogger } from '../../shared/logger';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import { handle } from '../../shared/middlewares/validate';

import { IssueTicketBody } from './tickets.schema';

/** Tickets of the running realtime server (same Redis prefix), or a direct service. */
const ticketService = () =>
  tryGetRealtime()?.tickets ?? new WsTicketService(getAppRedis(getEnv().REDIS_URL, getLogger()));

/**
 * `POST /api/v1/ws/tickets` — single-use, 60 s ticket for `/ws/events`
 * (websocket.md §2). 30 per minute per user (reconnect storms).
 */
export const createWsTicketsRouter = (): Router => {
  const router = Router();
  const limiter = createRateLimiter({
    windowMs: 60_000,
    limit: 30,
    keyGenerator: (req) => `ws-ticket:${req.auth?.userId ?? 'anonymous'}`,
  });
  router.post(
    '/tickets',
    authenticate(),
    limiter,
    ...handle({ body: IssueTicketBody }, async ({ body, req, res }) => {
      const auth = requireAuth(req);
      created(
        res,
        await ticketService().issue({
          userId: auth.userId ?? '',
          accountId: auth.accountId,
          channel: body.channel,
        }),
      );
    }),
  );
  return router;
};
