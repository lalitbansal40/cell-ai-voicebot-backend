import { Router } from 'express';

import { getSystemInfo } from './system.controller';

export const createSystemRouter = (): Router => {
  const router = Router();
  router.get('/info', getSystemInfo);
  return router;
};
