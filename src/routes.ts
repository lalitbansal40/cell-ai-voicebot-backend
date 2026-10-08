import { Router } from 'express';

import type { Env } from './config/env';
import { createAccountRouter } from './modules/account/account.routes';
import { createAuthRouter, type AuthRouterDeps } from './modules/auth/auth.routes';
import { createOpenApiHandler } from './modules/docs/openapi.controller';
import { createRbacRouter } from './modules/rbac/rbac.routes';
import { createSystemRouter } from './modules/system/system.routes';
import { createTeamRouter } from './modules/team/team.routes';

/** Everything under /api/v1. Add each module router here. */
export const createApiRouter = ({
  env,
  auth = {},
}: {
  env: Pick<Env, 'APP_URL' | 'CORS_ORIGINS' | 'NODE_ENV'>;
  auth?: Omit<AuthRouterDeps, 'env'>;
}): Router => {
  const router = Router();
  router.use('/auth', createAuthRouter({ ...auth, env }));
  router.use('/account', createAccountRouter());
  router.use('/team', createTeamRouter());
  router.get('/openapi.json', createOpenApiHandler(env.APP_URL));
  router.use('/system', createSystemRouter());
  router.use('/rbac', createRbacRouter());
  return router;
};
