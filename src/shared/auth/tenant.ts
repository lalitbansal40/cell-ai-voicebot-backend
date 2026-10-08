import type { Request } from 'express';
import { Types, type Model } from 'mongoose';

import { NotFoundError } from '../errors/app-error';

import { requireAuth } from './auth-context';

/** `{ accountId }` filter from the authenticated caller (api.md §13 — never from the request). */
export const tenantFilter = (req: Request): { accountId: Types.ObjectId } => ({
  accountId: new Types.ObjectId(requireAuth(req).accountId),
});

/** Accepts only 24-hex ids; anything else is simply "not found". */
export const toObjectId = (id: string): Types.ObjectId | undefined =>
  /^[a-f0-9]{24}$/i.test(id) ? new Types.ObjectId(id) : undefined;

/**
 * Loads a document of the caller's account by id. A document of another
 * account answers 404 (never 403 — no existence leak).
 */
export const findOwnedOr404 = async <T>(
  model: Model<T>,
  id: string,
  req: Request,
  projection?: Record<string, 0 | 1>,
): Promise<T> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const doc = await model.findOne({ _id, ...tenantFilter(req) }, projection).lean<T>();
  if (!doc) throw new NotFoundError();
  return doc;
};

/** Idempotency middleware scope (api.md §10): the authenticated account. */
export const accountScope = (req: Request): string | undefined => req.auth?.accountId;
