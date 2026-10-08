import { Router } from 'express';

import { authenticate } from '../../shared/middlewares/authenticate';

import { getCatalog } from './rbac.controller';

export const createRbacRouter = (): Router => {
  const router = Router();
  router.get('/permissions', authenticate(), getCatalog);
  return router;
};
