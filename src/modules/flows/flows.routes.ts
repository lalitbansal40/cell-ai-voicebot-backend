import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import { FLOW_LIMITS } from '../../config/limits';
import { flowCatalog } from '../../core/engine/catalog';
import { created, noContent, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';

import {
  CreateFlowBody,
  ExportQuery,
  FlowParams,
  ImportBody,
  ListFlowsQuery,
  PublishBody,
  RestoreBody,
  SaveDraftBody,
  UpdateFlowBody,
  ValidateBody,
  VersionParams,
} from './flows.schema';
import {
  createFlow,
  deleteFlow,
  duplicateFlow,
  flowVariables,
  getFlow,
  listFlows,
  saveDraft,
  setArchived,
  updateFlow,
  validateDraft,
} from './flows.service';
import { exportFlow, importFlow } from './import-export';
import {
  ListSimulationsQuery,
  RunParams,
  SimulationInputBody,
  StartSimulationBody,
  StatsQuery,
} from './simulator.schema';
import {
  flowStats,
  getSimulation,
  listSimulations,
  sendInput,
  startSimulation,
  type SimulatorDeps,
} from './simulator.service';
import { listFlowTemplates } from './templates';
import { getVersion, listVersions, publishFlow, restoreVersion } from './versions.service';

export type FlowsRouterDeps = SimulatorDeps & { simulatorStore?: Store };

/** `/api/v1/flows` — call flows: drafts, validation, versions, templates, import / export. */
export const createFlowsRouter = (deps: FlowsRouterDeps): Router => {
  const router = Router();
  router.use(authenticate());
  const read = requirePermission('flows.read');
  const write = [requirePermission('flows.write'), blockWhenImpersonating()];
  const publish = [requirePermission('flows.publish'), blockWhenImpersonating()];
  const simulatorLimiter = createRateLimiter({
    windowMs: 60_000,
    limit: FLOW_LIMITS.simulatorInputsPerMinute,
    keyGenerator: (req) => `flowsim:${req.auth?.userId ?? 'anonymous'}`,
    ...(deps.simulatorStore ? { store: deps.simulatorStore } : {}),
  });

  router.get(
    '/',
    read,
    ...handle({ query: ListFlowsQuery }, async ({ query, req, res }) => {
      const page = await listFlows(req, query);
      ok(res, page.items, page.meta);
    }),
  );
  router.post(
    '/',
    ...write,
    ...handle({ body: CreateFlowBody }, async ({ body, req, res }) => {
      created(res, await createFlow(req, body, deps));
    }),
  );
  router.get('/templates', read, (_req, res) => {
    ok(res, listFlowTemplates());
  });
  router.get('/catalog', read, (_req, res) => {
    ok(res, flowCatalog());
  });
  router.post(
    '/import',
    ...write,
    ...handle({ body: ImportBody }, async ({ body, req, res }) => {
      created(res, await importFlow(req, body, deps));
    }),
  );
  router.get(
    '/:id',
    read,
    ...handle({ params: FlowParams }, async ({ params, req, res }) => {
      ok(res, await getFlow(req, params.id, deps));
    }),
  );
  router.patch(
    '/:id',
    ...write,
    ...handle({ params: FlowParams, body: UpdateFlowBody }, async ({ params, body, req, res }) => {
      ok(res, await updateFlow(req, params.id, body, deps));
    }),
  );
  router.delete(
    '/:id',
    ...write,
    ...handle({ params: FlowParams }, async ({ params, req, res }) => {
      await deleteFlow(req, params.id);
      noContent(res);
    }),
  );
  router.put(
    '/:id/draft',
    ...write,
    ...handle({ params: FlowParams, body: SaveDraftBody }, async ({ params, body, req, res }) => {
      ok(res, await saveDraft(req, params.id, body, deps));
    }),
  );
  router.post(
    '/:id/validate',
    read,
    ...handle({ params: FlowParams, body: ValidateBody }, async ({ params, body, req, res }) => {
      ok(res, await validateDraft(req, params.id, body.graph, deps));
    }),
  );
  router.post(
    '/:id/publish',
    ...publish,
    ...handle({ params: FlowParams, body: PublishBody }, async ({ params, body, req, res }) => {
      created(res, await publishFlow(req, params.id, body, deps));
    }),
  );
  router.get(
    '/:id/versions',
    read,
    ...handle({ params: FlowParams }, async ({ params, req, res }) => {
      ok(res, await listVersions(req, params.id));
    }),
  );
  router.get(
    '/:id/versions/:version',
    read,
    ...handle({ params: VersionParams }, async ({ params, req, res }) => {
      ok(res, await getVersion(req, params.id, params.version));
    }),
  );
  router.post(
    '/:id/versions/:version/restore',
    ...publish,
    ...handle({ params: VersionParams, body: RestoreBody }, async ({ params, body, req, res }) => {
      ok(res, await restoreVersion(req, params.id, params.version, body, deps));
    }),
  );
  router.post(
    '/:id/duplicate',
    ...write,
    ...handle({ params: FlowParams }, async ({ params, req, res }) => {
      created(res, await duplicateFlow(req, params.id, deps));
    }),
  );
  router.post(
    '/:id/archive',
    ...write,
    ...handle({ params: FlowParams }, async ({ params, req, res }) => {
      ok(res, await setArchived(req, params.id, true, deps));
    }),
  );
  router.post(
    '/:id/unarchive',
    ...write,
    ...handle({ params: FlowParams }, async ({ params, req, res }) => {
      ok(res, await setArchived(req, params.id, false, deps));
    }),
  );
  router.get(
    '/:id/export',
    ...write,
    ...handle({ params: FlowParams, query: ExportQuery }, async ({ params, query, req, res }) => {
      const file = await exportFlow(req, params.id, query.version);
      res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.json(file.body);
    }),
  );
  router.get(
    '/:id/variables',
    read,
    ...handle({ params: FlowParams }, async ({ params, req, res }) => {
      ok(res, await flowVariables(req, params.id));
    }),
  );
  router.get(
    '/:id/stats',
    read,
    ...handle({ params: FlowParams, query: StatsQuery }, async ({ params, query, req, res }) => {
      ok(res, await flowStats(req, params.id, query));
    }),
  );
  router.post(
    '/:id/simulations',
    ...write,
    simulatorLimiter,
    ...handle(
      { params: FlowParams, body: StartSimulationBody },
      async ({ params, body, req, res }) => {
        created(res, await startSimulation(req, params.id, body, deps));
      },
    ),
  );
  router.get(
    '/:id/simulations',
    read,
    ...handle(
      { params: FlowParams, query: ListSimulationsQuery },
      async ({ params, query, req, res }) => {
        ok(res, await listSimulations(req, params.id, query));
      },
    ),
  );
  router.get(
    '/:id/simulations/:runId',
    read,
    ...handle({ params: RunParams }, async ({ params, req, res }) => {
      ok(res, await getSimulation(req, params.id, params.runId));
    }),
  );
  router.post(
    '/:id/simulations/:runId/inputs',
    ...write,
    simulatorLimiter,
    ...handle(
      { params: RunParams, body: SimulationInputBody },
      async ({ params, body, req, res }) => {
        ok(res, await sendInput(req, params.id, params.runId, body, deps));
      },
    ),
  );
  return router;
};
