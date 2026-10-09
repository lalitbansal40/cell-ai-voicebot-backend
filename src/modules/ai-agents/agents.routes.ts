import { Router } from 'express';

import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  AgentParams,
  CompilePreviewBody,
  CreateAgentBody,
  ListAgentsQuery,
  UpdateAgentBody,
} from './agents.schema';
import {
  agentCatalog,
  agentUsage,
  compilePreview,
  createAgent,
  deleteAgent,
  duplicateAgent,
  getAgent,
  listAgents,
  listTemplates,
  setAgentActive,
  updateAgent,
  type AgentsDeps,
} from './agents.service';

/** `/api/v1/agents` — AI agents CRUD, templates and the prompt preview. */
export const createAgentsRouter = (deps: AgentsDeps): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('agents.read');
  const write = [requirePermission('agents.write'), blockWhenImpersonating()];

  router.get(
    '/',
    read,
    ...handle({ query: ListAgentsQuery }, async ({ query, req, res }) => {
      const page = await listAgents(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.post(
    '/',
    ...write,
    ...handle({ body: CreateAgentBody }, async ({ body, req, res }) => {
      created(res, await createAgent(req, body, deps));
    }),
  );
  router.get('/templates', read, (_req, res) => {
    ok(res, listTemplates(deps));
  });
  router.get(
    '/catalog',
    read,
    ...handle({}, async ({ req, res }) => {
      ok(res, await agentCatalog(req, deps));
    }),
  );
  router.get(
    '/:id',
    read,
    ...handle({ params: AgentParams }, async ({ params, req, res }) => {
      ok(res, await getAgent(req, params.id));
    }),
  );
  router.patch(
    '/:id',
    ...write,
    ...handle(
      { params: AgentParams, body: UpdateAgentBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateAgent(req, params.id, body, deps));
      },
    ),
  );
  router.delete(
    '/:id',
    ...write,
    ...handle({ params: AgentParams }, async ({ params, req, res }) => {
      await deleteAgent(req, params.id);
      noContent(res);
    }),
  );
  router.post(
    '/:id/duplicate',
    ...write,
    ...handle({ params: AgentParams }, async ({ params, req, res }) => {
      created(res, await duplicateAgent(req, params.id));
    }),
  );
  router.post(
    '/:id/activate',
    ...write,
    ...handle({ params: AgentParams }, async ({ params, req, res }) => {
      ok(res, await setAgentActive(req, params.id, true));
    }),
  );
  router.post(
    '/:id/deactivate',
    ...write,
    ...handle({ params: AgentParams }, async ({ params, req, res }) => {
      ok(res, await setAgentActive(req, params.id, false));
    }),
  );
  router.post(
    '/:id/compile-preview',
    read,
    ...handle(
      { params: AgentParams, body: CompilePreviewBody },
      async ({ params, body, req, res }) => {
        ok(res, await compilePreview(req, params.id, body));
      },
    ),
  );
  router.get(
    '/:id/usage',
    read,
    ...handle({ params: AgentParams }, async ({ params, req, res }) => {
      ok(res, await agentUsage(req, params.id));
    }),
  );
  return router;
};
