import { Router } from 'express';

import { tenantFilter } from '../../shared/auth/tenant';
import { ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { handle } from '../../shared/middlewares/validate';

import { ResourceAgentsQuery, ResourceFlowsQuery } from './resources.schema';
import {
  listResourceAgents,
  listResourceChannels,
  listResourceFlows,
  listResourceLists,
  listResourceSegments,
  resourceIvrs,
  resourcePhoneLine,
  resourceWallet,
} from './resources.service';

const scope = 'resources:read' as const;

/** `/api/v1/resources/*` — read-only ids and balances for API clients (and the dashboard). */
export const createResourcesRouter = (): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  router.get(
    '/flows',
    access({ permission: 'flows.read', scope }),
    ...handle({ query: ResourceFlowsQuery }, async ({ query, req, res }) => {
      ok(res, await listResourceFlows(tenantFilter(req).accountId, query.status));
    }),
  );
  router.get(
    '/agents',
    access({ permission: 'agents.read', scope }),
    ...handle({ query: ResourceAgentsQuery }, async ({ query, req, res }) => {
      ok(res, await listResourceAgents(tenantFilter(req).accountId, query.active === 'true'));
    }),
  );
  router.get(
    '/whatsapp-numbers',
    access({ permission: 'whatsapp.read', scope }),
    async (req, res) => {
      ok(res, await listResourceChannels(tenantFilter(req).accountId));
    },
  );
  router.get('/contact-lists', access({ permission: 'contacts.read', scope }), async (req, res) => {
    ok(res, await listResourceLists(tenantFilter(req).accountId));
  });
  router.get('/segments', access({ permission: 'contacts.read', scope }), async (req, res) => {
    ok(res, await listResourceSegments(tenantFilter(req).accountId));
  });
  router.get('/phone-line', access({ permission: 'account.read', scope }), async (req, res) => {
    ok(res, await resourcePhoneLine(tenantFilter(req).accountId));
  });
  router.get(
    '/ivrs',
    access({ permission: ['campaigns.read', 'account.read'], scope }),
    async (req, res) => {
      ok(res, await resourceIvrs(tenantFilter(req).accountId));
    },
  );
  router.get('/wallet', access({ permission: 'wallet.read', scope }), async (req, res) => {
    ok(res, await resourceWallet(tenantFilter(req).accountId));
  });
  return router;
};
