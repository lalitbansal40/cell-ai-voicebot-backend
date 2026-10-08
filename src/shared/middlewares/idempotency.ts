import type { Request, RequestHandler, Response } from 'express';

import { IdempotencyKeyModel } from '../../db/models/idempotency-key.model';
import { AppError, ValidationError } from '../errors/app-error';
import { hashRequest } from '../utils/stable-json';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';
const VALID_KEY = /^[A-Za-z0-9_.:-]{1,255}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface IdempotencyOptions {
  /** Reject requests without the header (default true). */
  required?: boolean;
  /** Tenant scope — Phase 2 returns the authenticated accountId. */
  scope: (req: Request) => string | undefined;
  ttlMs?: number;
}

const isDuplicateKey = (err: unknown): boolean => (err as { code?: number }).code === 11000;

/**
 * Idempotency-Key handling (docs/conventions/api.md §10):
 * same key + same body → stored response replayed (`Idempotent-Replayed: true`);
 * same key + different body → 422 IDEMPOTENCY_KEY_REUSED; still running → 409 IDEMPOTENCY_IN_PROGRESS.
 * The result is stored BEFORE the response is sent, so an immediate retry always sees it.
 * 5xx responses are not stored (the record is deleted, so the client may retry).
 */
export const idempotency =
  ({ required = true, scope, ttlMs = DAY_MS }: IdempotencyOptions): RequestHandler =>
  async (req, res, next) => {
    const key = req.get(IDEMPOTENCY_HEADER);
    if (!key) {
      if (required)
        next(new ValidationError([{ path: 'headers.idempotency-key', message: 'Required' }]));
      else next();
      return;
    }
    if (!VALID_KEY.test(key)) {
      next(
        new ValidationError([
          {
            path: 'headers.idempotency-key',
            message: 'Must be 1–255 chars of A–Z a–z 0–9 _ . : -',
          },
        ]),
      );
      return;
    }
    const accountId = scope(req);
    if (!accountId) {
      next(new AppError('INTERNAL_ERROR', 'Idempotency scope missing'));
      return;
    }

    const path = req.originalUrl.split('?')[0] ?? req.path;
    const requestHash = hashRequest(req.method, path, req.body);

    try {
      await IdempotencyKeyModel.create({
        accountId,
        key,
        method: req.method,
        path,
        requestHash,
        status: 'in_progress',
        expiresAt: new Date(Date.now() + ttlMs),
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await IdempotencyKeyModel.findOne({ accountId, key }).lean();
      if (!existing) {
        next(new AppError('IDEMPOTENCY_IN_PROGRESS'));
        return;
      }
      if (existing.requestHash !== requestHash) {
        next(new AppError('IDEMPOTENCY_KEY_REUSED'));
        return;
      }
      if (existing.status === 'in_progress') {
        next(new AppError('IDEMPOTENCY_IN_PROGRESS'));
        return;
      }
      res.setHeader(REPLAYED_HEADER, 'true');
      res.status(existing.responseStatus ?? 200);
      if (existing.responseBody === undefined || existing.responseBody === null) res.end();
      else res.json(existing.responseBody);
      return;
    }

    let settled = false;
    const persist = async (status: number, body: unknown): Promise<void> => {
      if (settled) return;
      settled = true;
      if (status >= 500) await IdempotencyKeyModel.deleteOne({ accountId, key });
      else
        await IdempotencyKeyModel.updateOne(
          { accountId, key },
          { $set: { status: 'completed', responseStatus: status, responseBody: body ?? null } },
        );
    };

    const originalJson = res.json.bind(res) as Response['json'];
    res.json = ((body: unknown) => {
      persist(res.statusCode, body)
        .catch((err: unknown) => req.log.error({ err }, 'idempotency: could not store response'))
        .finally(() => originalJson(body));
      return res;
    }) as Response['json'];

    // Responses that bypass res.json (e.g. 204 end()) are stored after they finish.
    res.on('finish', () => {
      persist(res.statusCode, undefined).catch((err: unknown) =>
        req.log.error({ err }, 'idempotency: could not store response'),
      );
    });

    next();
  };
