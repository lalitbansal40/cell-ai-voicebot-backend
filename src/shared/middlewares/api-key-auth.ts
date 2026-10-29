import { BlockList, isIP } from 'node:net';

import type { Request, RequestHandler } from 'express';

import { PUBLIC_API_LIMITS } from '../../config/limits';
import { AccountModel, type AccountStatus } from '../../db/models/account.model';
import { ApiKeyModel } from '../../db/models/api-key.model';
import { permissionsForScopes } from '../../modules/api-keys/scopes';
import { sha256Hex } from '../../modules/auth/hmac';
import type { AuthContext } from '../auth/auth-context';
import { AppError, ForbiddenError, UnauthenticatedError } from '../errors/app-error';

export const API_KEY_HEADER = 'X-API-Key';
export const API_KEY_FORMAT = /^cav_(live|test)_[A-Za-z0-9]{32}$/;
const LAST_USED_THROTTLE_MS = 60_000;
export const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What a key resolves to (cached ≤ `PUBLIC_API_LIMITS.keyCacheSec`; never the hash or the key). */
export interface ResolvedApiKey {
  id: string;
  accountId: string;
  ownerId: string;
  scopes: ReadonlySet<string>;
  ipAllowlist: readonly string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  account: { id: string; status: AccountStatus; timezone: string; isPlatform: boolean };
}

interface CacheEntry {
  key: ResolvedApiKey | null;
  until: number;
}

/** In-process cache by key hash: revocation / edits drop the entry here; other instances within 30 s. */
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 5_000;

/** Drops one key (by id) or everything from the cache — called on revoke / edit. */
export const invalidateApiKeyCache = (keyId?: string): void => {
  if (!keyId) {
    cache.clear();
    return;
  }
  for (const [hash, entry] of cache) if (entry.key?.id === keyId) cache.delete(hash);
};

const load = async (hash: string): Promise<ResolvedApiKey | null> => {
  const key = await ApiKeyModel.findOne({ keyHash: hash, revokedAt: null }).lean();
  if (!key) return null;
  const account = await AccountModel.findById(key.accountId)
    .select({ status: 1, timezone: 1, isPlatform: 1 })
    .lean();
  if (!account) return null;
  return {
    id: key._id.toString(),
    accountId: key.accountId.toString(),
    ownerId: key.createdBy.toString(),
    scopes: new Set(key.scopes),
    ipAllowlist: [...(key.ipAllowlist ?? [])],
    expiresAt: key.expiresAt ?? null,
    lastUsedAt: key.lastUsedAt ?? null,
    account: {
      id: account._id.toString(),
      status: account.status,
      timezone: account.timezone,
      isPlatform: account.isPlatform,
    },
  };
};

const lookup = async (hash: string): Promise<ResolvedApiKey | null> => {
  const now = Date.now();
  const hit = cache.get(hash);
  if (hit && hit.until > now) return hit.key;
  const key = await load(hash);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(hash, { key, until: now + PUBLIC_API_LIMITS.keyCacheSec * 1000 });
  return key;
};

/** `::ffff:10.0.0.1` → `10.0.0.1`. */
export const normalizeIp = (ip: string): string => {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return mapped?.[1] ?? ip;
};

/** `10.0.0.0/8`, `203.0.113.7`, `2001:db8::/32` … → a valid entry, else null. */
export const parseCidr = (
  entry: string,
): { address: string; prefix: number; type: 'ipv4' | 'ipv6' } | null => {
  const [address = '', bits] = entry.trim().split('/');
  const version = isIP(address);
  if (!version) return null;
  const type = version === 4 ? 'ipv4' : 'ipv6';
  const max = version === 4 ? 32 : 128;
  if (bits === undefined) return { address, prefix: max, type };
  if (!/^\d{1,3}$/.test(bits)) return null;
  const prefix = Number(bits);
  return prefix <= max ? { address, prefix, type } : null;
};

/** True when `ip` is inside one of the CIDR entries (empty list = everyone). */
export const ipAllowed = (allowlist: readonly string[], ip: string | undefined): boolean => {
  if (!allowlist.length) return true;
  if (!ip) return false;
  const address = normalizeIp(ip);
  const version = isIP(address);
  if (!version) return false;
  const list = new BlockList();
  for (const entry of allowlist) {
    const cidr = parseCidr(entry);
    if (cidr) list.addSubnet(cidr.address, cidr.prefix, cidr.type);
  }
  return list.check(address, version === 4 ? 'ipv4' : 'ipv6');
};

const resolved = new WeakMap<Request, ResolvedApiKey>();

/**
 * Verifies the `X-API-Key` of a request (once per request): format, not revoked,
 * not expired (401 API_KEY_EXPIRED), client IP in the allowlist (403
 * API_KEY_IP_DENIED, IP from `req.ip` — `X-Forwarded-For` only per TRUST_PROXY),
 * suspended accounts read-only. Keys are high-entropy random strings, so a plain
 * SHA-256 lookup is enough (no per-key salt needed).
 */
export const resolveApiKey = async (req: Request): Promise<ResolvedApiKey> => {
  const done = resolved.get(req);
  if (done) return done;
  const raw = req.get(API_KEY_HEADER);
  if (!raw || !API_KEY_FORMAT.test(raw)) throw new UnauthenticatedError();
  const key = await lookup(sha256Hex(raw));
  if (!key) throw new UnauthenticatedError();
  if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) throw new AppError('API_KEY_EXPIRED');
  if (!ipAllowed(key.ipAllowlist, req.ip)) throw new AppError('API_KEY_IP_DENIED');
  if (key.account.status === 'suspended' && !READ_METHODS.has(req.method)) {
    throw new AppError('AUTH_ACCOUNT_SUSPENDED');
  }
  if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
    key.lastUsedAt = new Date();
    void ApiKeyModel.updateOne({ _id: key.id }, { $set: { lastUsedAt: key.lastUsedAt } }).catch(
      (err: unknown) => req.log.warn({ err }, 'api key lastUsedAt update failed'),
    );
  }
  resolved.set(req, key);
  return key;
};

/**
 * The auth context of a resolved key. `permissions` = what its scopes allow inside
 * the services; routes still open to keys only through `access({ scope })`.
 */
export const apiKeyContext = (key: ResolvedApiKey): AuthContext => ({
  kind: 'api_key',
  accountId: key.accountId,
  apiKeyId: key.id,
  keyOwnerId: key.ownerId,
  permissions: permissionsForScopes(key.scopes),
  scopes: key.scopes,
  account: { ...key.account },
});

/** True when the request carries an API key and no dashboard session. */
export const isApiKeyRequest = (req: Request): boolean =>
  Boolean(req.get(API_KEY_HEADER)) && !req.get('authorization');

/**
 * Public-API auth for key-only routes (`whoami`). `scopes`: every listed scope is required.
 */
export const apiKeyAuth =
  ({ scopes = [] }: { scopes?: string[] } = {}): RequestHandler =>
  async (req, _res, next) => {
    const key = await resolveApiKey(req);
    if (!scopes.every((s) => key.scopes.has(s))) throw new ForbiddenError();
    req.auth = apiKeyContext(key);
    req.log = req.log.child({ accountId: key.accountId, apiKeyId: key.id });
    next();
  };
