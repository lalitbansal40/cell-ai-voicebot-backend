import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import { AI_LIMITS } from '../../config/limits';
import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  AgentParams,
  CompilePreviewBody,
  CreateAgentBody,
  CreateFunctionBody,
  FunctionParams,
  ListAgentsQuery,
  TestFunctionBody,
  UpdateAgentBody,
  UpdateFunctionBody,
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
import {
  createFunction,
  deleteFunction,
  testFunction,
  updateFunction,
  type FunctionsDeps,
} from './functions.service';
import { createPlaygroundRouter } from './playground.routes';
import type { PlaygroundDeps } from './playground.service';

export type AgentsRouterDeps = AgentsDeps &
  FunctionsDeps & {
    env: AgentsDeps['env'] & FunctionsDeps['env'] & PlaygroundDeps['env'];
    provider: PlaygroundDeps['provider'];
    functionTestStore?: Store;
    playgroundStore?: Store;
  };

/** `/api/v1/agents` — AI agents CRUD, templates, prompt preview and custom functions. */
export const createAgentsRouter = (deps: AgentsRouterDeps): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('agents.read');
  const write = [requirePermission('agents.write'), blockWhenImpersonating()];
  const testLimiter = createRateLimiter({
    windowMs: 60_000,
    limit: AI_LIMITS.functionTestsPerMinute,
    keyGenerator: (req) => `fntest:${req.auth?.userId ?? 'anonymous'}`,
    ...(deps.functionTestStore ? { store: deps.functionTestStore } : {}),
  });

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

  router.post(
    '/:id/functions',
    ...write,
    ...handle(
      { params: AgentParams, body: CreateFunctionBody },
      async ({ params, body, req, res }) => {
        created(res, await createFunction(req, params.id, body, deps));
      },
    ),
  );
  router.patch(
    '/:id/functions/:fnId',
    ...write,
    ...handle(
      { params: FunctionParams, body: UpdateFunctionBody },
      async ({ params, body, req, res }) => {
        ok(res, await updateFunction(req, params.id, params.fnId, body, deps));
      },
    ),
  );
  router.delete(
    '/:id/functions/:fnId',
    ...write,
    ...handle({ params: FunctionParams }, async ({ params, req, res }) => {
      ok(res, await deleteFunction(req, params.id, params.fnId));
    }),
  );
  router.post(
    '/:id/functions/:fnId/test',
    ...write,
    testLimiter,
    ...handle(
      { params: FunctionParams, body: TestFunctionBody },
      async ({ params, body, req, res }) => {
        ok(res, await testFunction(req, params.id, params.fnId, body, deps));
      },
    ),
  );
  router.use(
    '/:id/playground/sessions',
    createPlaygroundRouter({
      env: deps.env,
      provider: deps.provider,
      secretKey: deps.secretKey,
      ...(deps.http ? { http: deps.http } : {}),
      ...(deps.playgroundStore ? { messagesStore: deps.playgroundStore } : {}),
    }),
  );
  return router;
};
