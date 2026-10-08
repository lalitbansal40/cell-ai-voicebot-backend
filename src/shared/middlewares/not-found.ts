import type { RequestHandler } from 'express';

import { NotFoundError } from '../errors/app-error';

/** Fallback for unmatched routes → 404 RESOURCE_NOT_FOUND envelope. */
export const notFound = (): RequestHandler => (_req, _res, next) => {
  next(new NotFoundError('Route not found'));
};
