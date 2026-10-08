import type { RequestHandler } from 'express';

import { AccountModel } from '../../db/models/account.model';
import { ApiKeyModel } from '../../db/models/api-key.model';
import { sha256Hex } from '../../modules/auth/hmac';
import { AppError, ForbiddenError, UnauthenticatedError } from '../errors/app-error';

export const API_KEY_HEADER = 'X-API-Key';
export const API_KEY_FORMAT = /^cav_(live|test)_[A-Za-z0-9]{32}$/;
const LAST_USED_THROTTLE_MS = 60_000;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Public-API auth (`X-API-Key`, api.md §12). Keys are high-entropy random
 * strings, so a plain SHA-256 lookup is enough (no per-key salt needed).
 * `scopes`: every listed scope is required.
 */
export const apiKeyAuth =
  ({ scopes = [] }: { scopes?: string[] } = {}): RequestHandler =>
  async (req, _res, next) => {
    const raw = req.get(API_KEY_HEADER);
    if (!raw || !API_KEY_FORMAT.test(raw)) throw new UnauthenticatedError();
    const key = await ApiKeyModel.findOne({ keyHash: sha256Hex(raw), revokedAt: null }).lean();
    if (!key) throw new UnauthenticatedError();
    const account = await AccountModel.findById(key.accountId)
      .select({ status: 1, timezone: 1, isPlatform: 1 })
      .lean();
    if (!account) throw new UnauthenticatedError();
    if (account.status === 'suspended' && !READ_METHODS.has(req.method)) {
      throw new AppError('AUTH_ACCOUNT_SUSPENDED');
    }
    const keyScopes = new Set(key.scopes);
    if (!scopes.every((s) => keyScopes.has(s))) throw new ForbiddenError();

    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_THROTTLE_MS) {
      void ApiKeyModel.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } }).catch(
        (err: unknown) => req.log.warn({ err }, 'api key lastUsedAt update failed'),
      );
    }

    req.auth = {
      kind: 'api_key',
      accountId: key.accountId.toString(),
      apiKeyId: key._id.toString(),
      permissions: new Set(),
      scopes: keyScopes,
      account: {
        id: account._id.toString(),
        status: account.status,
        timezone: account.timezone,
        isPlatform: account.isPlatform,
      },
    };
    req.log = req.log.child({ accountId: req.auth.accountId, apiKeyId: req.auth.apiKeyId });
    next();
  };
