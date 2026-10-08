import { randomInt } from 'node:crypto';

import type { Request } from 'express';
import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { ApiKeyModel, type ApiKeyDoc } from '../../db/models/api-key.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';
import { sha256Hex } from '../auth/hmac';

export const MAX_ACTIVE_KEYS = 20;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PREFIX_LENGTH = 13;

/** `cav_live_` (production) / `cav_test_` + 32 base62 chars (~190 bits). */
export const generateApiKey = (production = getEnv().NODE_ENV === 'production'): string => {
  let body = '';
  for (let i = 0; i < 32; i += 1) body += BASE62[randomInt(0, BASE62.length)];
  return `cav_${production ? 'live' : 'test'}_${body}`;
};

const toPublic = (k: ApiKeyDoc) => ({
  id: k._id.toString(),
  name: k.name,
  prefix: k.prefix,
  scopes: [...k.scopes],
  lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
  revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
  createdBy: k.createdBy.toString(),
  createdAt: k.createdAt.toISOString(),
});

export const listApiKeys = async (req: Request) => {
  const keys = await ApiKeyModel.find(tenantFilter(req))
    .sort({ createdAt: -1 })
    .lean<ApiKeyDoc[]>();
  return keys.map(toPublic);
};

export const createApiKey = async (req: Request, body: { name: string; scopes: string[] }) => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  if ((await ApiKeyModel.countDocuments({ accountId, revokedAt: null })) >= MAX_ACTIVE_KEYS) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${MAX_ACTIVE_KEYS} active API keys.`,
    );
  }
  const key = generateApiKey();
  const doc = await ApiKeyModel.create({
    accountId,
    name: body.name,
    prefix: key.slice(0, PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes: body.scopes,
    createdBy: new Types.ObjectId(auth.userId),
  });
  const apiKey = toPublic(doc.toObject({ transform: false }));
  await auditRequest(req, 'apikey.created', {
    target: { type: 'api_key', id: apiKey.id },
    meta: { name: body.name, scopes: body.scopes, prefix: apiKey.prefix },
  });
  return { apiKey, key };
};

export const revokeApiKey = async (req: Request, id: string): Promise<void> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const key = await ApiKeyModel.findOne({ _id, ...tenantFilter(req) }).lean<ApiKeyDoc>();
  if (!key) throw new NotFoundError();
  if (key.revokedAt) return;
  await ApiKeyModel.updateOne({ _id }, { $set: { revokedAt: new Date() } });
  await auditRequest(req, 'apikey.revoked', {
    target: { type: 'api_key', id },
    meta: { name: key.name, prefix: key.prefix },
  });
};
