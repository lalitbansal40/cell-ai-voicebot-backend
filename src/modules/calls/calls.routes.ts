import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import { CALL_LIMITS, CAMPAIGN_LIMITS } from '../../config/limits';
import { accepted, created, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { startSingleCall } from '../campaigns/single-call';

import { CallParams, ListCallsQuery, StartCallBody, StartWebCallBody } from './calls.schema';
import {
  activeCalls,
  callEvents,
  callTranscript,
  getCall,
  hangupCall,
  listCalls,
  recordingLink,
  startWebCall,
  type CallsDeps,
} from './calls.service';

export type CallsRouterDeps = CallsDeps & { webCallStore?: Store; calloutStore?: Store };

/** `/api/v1/calls` — browser test calls, history, transcripts, recordings (PHASE_7_PLAN §1o). */
export const createCallsRouter = (deps: CallsRouterDeps): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('calls.read');
  const trigger = [requirePermission('calls.trigger'), blockWhenImpersonating()];
  const listen = [requirePermission('calls.listen'), blockWhenImpersonating()];
  const webCallLimiter = createRateLimiter({
    windowMs: 60_000,
    limit: CALL_LIMITS.webCallsPerMinutePerUser,
    keyGenerator: (req) => `callweb:${req.auth?.userId ?? 'anonymous'}`,
    ...(deps.webCallStore ? { store: deps.webCallStore } : {}),
  });

  const calloutLimiter = createRateLimiter({
    windowMs: 60_000,
    limit: CAMPAIGN_LIMITS.singleCallsPerMinutePerUser,
    keyGenerator: (req) => `callout:${req.auth?.userId ?? 'anonymous'}`,
    ...(deps.calloutStore ? { store: deps.calloutStore } : {}),
  });

  // one outbound call to a contact ("Call now", Phase 8)
  router.post(
    '/',
    ...trigger,
    calloutLimiter,
    idempotency({ scope: (req) => req.auth?.accountId }),
    ...handle({ body: StartCallBody }, async ({ body, req, res }) => {
      created(res, await startSingleCall(req, body, deps));
    }),
  );
  router.post(
    '/web',
    ...trigger,
    webCallLimiter,
    ...handle({ body: StartWebCallBody }, async ({ body, req, res }) => {
      created(res, await startWebCall(req, body, deps));
    }),
  );
  router.get(
    '/',
    read,
    ...handle({ query: ListCallsQuery }, async ({ query, req, res }) => {
      const page = await listCalls(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  // static paths before /:id
  router.get('/active', read, async (req, res) => {
    ok(res, await activeCalls(req, deps));
  });
  router.get(
    '/:id',
    read,
    ...handle({ params: CallParams }, async ({ params, req, res }) => {
      ok(res, await getCall(req, params.id));
    }),
  );
  router.get(
    '/:id/transcript',
    read,
    ...handle({ params: CallParams }, async ({ params, req, res }) => {
      ok(res, await callTranscript(req, params.id));
    }),
  );
  router.get(
    '/:id/events',
    read,
    ...handle({ params: CallParams }, async ({ params, req, res }) => {
      ok(res, await callEvents(req, params.id));
    }),
  );
  router.get(
    '/:id/recording',
    ...listen,
    ...handle({ params: CallParams }, async ({ params, req, res }) => {
      ok(res, await recordingLink(req, params.id, deps));
    }),
  );
  router.post(
    '/:id/hangup',
    ...trigger,
    ...handle({ params: CallParams }, async ({ params, req, res }) => {
      const { call, forwarded } = await hangupCall(req, params.id, deps);
      // forwarded: the owning process ends it shortly (the view may still show it live)
      if (forwarded) accepted(res, call);
      else ok(res, call);
    }),
  );
  return router;
};
