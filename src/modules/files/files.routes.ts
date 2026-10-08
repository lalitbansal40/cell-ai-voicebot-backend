import { Router } from 'express';

import type { LocalStorage } from '../../core/storage';

import { downloadFile } from './files.controller';

/** Signed downloads for the local storage driver (S3 uses presigned URLs instead). */
export const createFilesRouter = (storage: LocalStorage): Router => {
  const router = Router();
  router.get('/files/*key', downloadFile(storage));
  return router;
};
