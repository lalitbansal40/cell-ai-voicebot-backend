import { Router } from 'express';

import { accepted, created, noContent, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { blockWhenImpersonating } from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import type { WebhookRuntime } from './deliver.job';
import {
  CreateEndpointBody,
  DeliveriesQuery,
  EndpointParams,
  TestEventBody,
  UpdateEndpointBody,
} from './endpoints.schema';
import {
  createEndpoint,
  deleteEndpoint,
  enableEndpoint,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  replayDelivery,
  rotateSecret,
  sendTestEvent,
  updateEndpoint,
} from './endpoints.service';

/** `/api/v1/webhook-endpoints` — outbound webhooks (`integrations.manage` / `webhooks:manage`). */
export const createWebhookEndpointsRouter = (rt: WebhookRuntime): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  const manage = access({ permission: 'integrations.manage', scope: 'webhooks:manage' });
  const change = [manage, blockWhenImpersonating()];

  router.get('/', manage, async (req, res) => {
    ok(res, await listEndpoints(req));
  });
  router.post(
    '/',
    ...change,
    ...handle({ body: CreateEndpointBody }, async ({ body, req, res }) => {
      res.set('Cache-Control', 'no-store');
      created(res, await createEndpoint(rt, req, body));
    }),
  );
  router.get(
    '/:id',
    manage,
    ...handle({ params: EndpointParams }, async ({ params, req, res }) => {
      ok(res, await getEndpoint(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    ...change,
    ...handle(
      { params: EndpointParams, body: UpdateEndpointBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateEndpoint(rt, req, params.id, body));
      },
    ),
  );
  router.delete(
    '/:id',
    ...change,
    ...handle({ params: EndpointParams }, async ({ params, req, res }) => {
      await deleteEndpoint(req, params.id);
      noContent(res);
    }),
  );
  router.post(
    '/:id/test',
    ...change,
    ...handle(
      { params: EndpointParams, body: TestEventBody },
      async ({ params, body, req, res }) => {
        ok(res, await sendTestEvent(rt, req, params.id, body.type));
      },
    ),
  );
  router.post(
    '/:id/rotate-secret',
    ...change,
    ...handle({ params: EndpointParams }, async ({ params, req, res }) => {
      res.set('Cache-Control', 'no-store');
      ok(res, await rotateSecret(rt, req, params.id));
    }),
  );
  router.post(
    '/:id/enable',
    ...change,
    ...handle({ params: EndpointParams }, async ({ params, req, res }) => {
      ok(res, await enableEndpoint(req, params.id));
    }),
  );
  router.get(
    '/:id/deliveries',
    manage,
    ...handle(
      { params: EndpointParams, query: DeliveriesQuery },
      async ({ params, query, req, res }) => {
        ok(res, await listDeliveries(req, params.id, query));
      },
    ),
  );
  return router;
};

/** `/api/v1/webhook-deliveries/:id/replay`. */
export const createWebhookDeliveriesRouter = (): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  router.post(
    '/:id/replay',
    access({ permission: 'integrations.manage', scope: 'webhooks:manage' }),
    blockWhenImpersonating(),
    ...handle({ params: EndpointParams }, async ({ params, req, res }) => {
      accepted(res, await replayDelivery(req, params.id));
    }),
  );
  return router;
};
