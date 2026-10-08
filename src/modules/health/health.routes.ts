import { Router } from 'express';

import { getHealth, getReady, type ReadinessDeps } from './health.controller';

/** Mounted at the root (`/health`, `/ready`) for load balancers — not under /api/v1. */
export const createHealthRouter = (readiness: ReadinessDeps): Router => {
  const router = Router();
  router.get('/health', getHealth);
  router.get('/ready', getReady(readiness));
  return router;
};
