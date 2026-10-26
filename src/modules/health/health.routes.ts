import { Router } from 'express';

import { getHealth, getReady, type BuildInfo, type ReadinessDeps } from './health.controller';

/** Mounted at the root and at /api/v1; root paths remain compatible with probes. */
export const createHealthRouter = (
  readiness: ReadinessDeps,
  build: BuildInfo = { version: 'unknown', commit: 'unknown', builtAt: 'unknown' },
): Router => {
  const router = Router();
  router.get('/health', getHealth(build));
  router.get('/ready', getReady(readiness));
  return router;
};
