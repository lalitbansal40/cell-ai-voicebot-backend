import { Router } from 'express';

import type { Env } from './config/env';
import { createOpenApiHandler } from './modules/docs/openapi.controller';
import { createRbacRouter } from './modules/rbac/rbac.routes';
import { createSystemRouter } from './modules/system/system.routes';

/** Everything under /api/v1. Add each module router here. */
export const createApiRouter = ({ env }: { env: Pick<Env, 'APP_URL'> }): Router => {
  const router = Router();
  router.get('/openapi.json', createOpenApiHandler(env.APP_URL));
  router.use('/system', createSystemRouter());
  router.use('/rbac', createRbacRouter());
  return router;
};
