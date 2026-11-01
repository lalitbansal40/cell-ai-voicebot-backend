import { randomInt } from 'node:crypto';

import type { Request } from 'express';
import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { ApiKeyModel, type ApiKeyDoc } from '../../db/models/api-key.model';
import { ApiRequestLogModel } from '../../db/models/api-request-log.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { invalidateApiKeyCache } from '../../shared/middlewares/api-key-auth';
import { auditRequest } from '../audit/audit.service';
import { sha256Hex } from '../auth/hmac';

export const MAX_ACTIVE_KEYS = 20;
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const PREFIX_LENGTH = 13;

/** `cav_live_` (production) / `cav_test_` + 32 base62 chars (~190 bits). */
export const generateApiKey = (production = getEnv().NODE_ENV === 'production'): string => {
  let body = '';
  for (let i = 0; i < 32; i += 1) body += BASE62[randomInt(0, BASE62.length)];
  return `cav_${production ? 'live' : 'test'}_${body}`;
};

const DAY_MS = 86_400_000;

/** Requests in the last 7 days from the daily counters (UTC days, today included). */
const requests7d = (k: ApiKeyDoc, now = new Date()): number => {
  const first = new Date(now.getTime() - 6 * DAY_MS).toISOString().slice(0, 10);
  return (k.usage ?? [])
    .filter((u) => u.day >= first)
    .reduce((sum, u) => sum + u.reads + u.writes, 0);
};

const toPublic = (k: ApiKeyDoc, requests24h = 0) => ({
  id: k._id.toString(),
  name: k.name,
  prefix: k.prefix,
  scopes: [...k.scopes],
  ipAllowlist: [...(k.ipAllowlist ?? [])],
  expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
  lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
  revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
  requests24h,
  requests7d: requests7d(k),
  createdBy: k.createdBy.toString(),
  createdAt: k.createdAt.toISOString(),
});

/** Requests per key in the last 24 h (from the request log). */
const last24h = async (accountId: Types.ObjectId, keyIds: Types.ObjectId[]) => {
  if (!keyIds.length) return new Map<string, number>();
  const rows = await ApiRequestLogModel.aggregate<{ _id: Types.ObjectId; n: number }>([
    {
      $match: {
        accountId,
        apiKeyId: { $in: keyIds },
        at: { $gte: new Date(Date.now() - DAY_MS) },
      },
    },
    { $group: { _id: '$apiKeyId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id.toString(), r.n]));
};

export const listApiKeys = async (req: Request) => {
  const { accountId } = tenantFilter(req);
  const keys = await ApiKeyModel.find({ accountId }).sort({ createdAt: -1 }).lean<ApiKeyDoc[]>();
  const counts = await last24h(
    accountId,
    keys.filter((k) => !k.revokedAt).map((k) => k._id),
  );
  return keys.map((k) => toPublic(k, counts.get(k._id.toString()) ?? 0));
};

export interface ApiKeyInput {
  name: string;
  scopes: string[];
  ipAllowlist?: string[] | undefined;
  expiresAt?: string | null | undefined;
}

export const createApiKey = async (req: Request, body: ApiKeyInput) => {
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
    ipAllowlist: body.ipAllowlist ?? [],
    expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    createdBy: new Types.ObjectId(auth.userId),
  });
  const apiKey = toPublic(doc.toObject({ transform: false }));
  await auditRequest(req, 'apikey.created', {
    target: { type: 'api_key', id: apiKey.id },
    meta: {
      name: body.name,
      scopes: body.scopes,
      prefix: apiKey.prefix,
      ipAllowlistCount: apiKey.ipAllowlist.length,
      expiresAt: apiKey.expiresAt,
    },
  });
  return { apiKey, key };
};

const activeKey = async (req: Request, id: string): Promise<ApiKeyDoc> => {
  const _id = toObjectId(id);
  const key = _id
    ? await ApiKeyModel.findOne({ _id, ...tenantFilter(req) }).lean<ApiKeyDoc>()
    : null;
  if (!key) throw new NotFoundError();
  return key;
};

/** `PATCH /api-keys/:id` — name, scopes, IP allowlist, expiry; other instances pick it up within 30 s. */
export const updateApiKey = async (req: Request, id: string, body: Partial<ApiKeyInput>) => {
  const key = await activeKey(req, id);
  if (key.revokedAt) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This API key is revoked.');
  }
  const set: Record<string, unknown> = {};
  if (body.name !== undefined) set.name = body.name;
  if (body.scopes !== undefined) set.scopes = body.scopes;
  if (body.ipAllowlist !== undefined) set.ipAllowlist = body.ipAllowlist;
  if (body.expiresAt !== undefined)
    set.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
  const updated = await ApiKeyModel.findOneAndUpdate(
    { _id: key._id, accountId: key.accountId },
    { $set: set },
    { new: true },
  ).lean<ApiKeyDoc>();
  invalidateApiKeyCache(id);
  await auditRequest(req, 'apikey.updated', {
    target: { type: 'api_key', id },
    meta: {
      prefix: key.prefix,
      changed: Object.keys(set),
      ...(body.scopes ? { scopes: body.scopes } : {}),
      ...(body.ipAllowlist ? { ipAllowlistCount: body.ipAllowlist.length } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
    },
  });
  const counts = await last24h(key.accountId, [key._id]);
  return toPublic(updated as ApiKeyDoc, counts.get(id) ?? 0);
};

/** `GET /api-keys/:id/requests` — newest first, cursor by row id (7 days are kept). */
export const listKeyRequests = async (
  req: Request,
  id: string,
  q: { cursor?: string | undefined; limit: number },
) => {
  const key = await activeKey(req, id);
  const rows = await ApiRequestLogModel.find({
    accountId: key.accountId,
    apiKeyId: key._id,
    ...(q.cursor ? { _id: { $lt: new Types.ObjectId(q.cursor) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map((r) => ({
      id: r._id.toString(),
      method: r.method,
      route: r.route,
      status: r.status,
      ms: r.ms,
      requestId: r.requestId,
      at: r.at.toISOString(),
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
};

export const revokeApiKey = async (req: Request, id: string): Promise<void> => {
  const _id = toObjectId(id);
  if (!_id) throw new NotFoundError();
  const key = await ApiKeyModel.findOne({ _id, ...tenantFilter(req) }).lean<ApiKeyDoc>();
  if (!key) throw new NotFoundError();
  if (key.revokedAt) return;
  await ApiKeyModel.updateOne({ _id }, { $set: { revokedAt: new Date() } });
  invalidateApiKeyCache(id);
  await auditRequest(req, 'apikey.revoked', {
    target: { type: 'api_key', id },
    meta: { name: key.name, prefix: key.prefix },
  });
};
