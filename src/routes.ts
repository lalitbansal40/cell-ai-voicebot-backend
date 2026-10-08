import { Router } from 'express';

import { createSystemRouter } from './modules/system/system.routes';

/** Everything under /api/v1. Add each module router here. */
export const createApiRouter = (): Router => {
  const router = Router();
  router.use('/system', createSystemRouter());
  return router;
};
