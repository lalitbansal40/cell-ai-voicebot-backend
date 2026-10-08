import type { RequestHandler } from 'express';

import { AppError, type ErrorDetail } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';

export interface ReadinessDeps {
  /** Named dependency checks, e.g. `{ mongo: () => pingMongo(), redis: () => pingRedis(client) }`. */
  checks: Record<string, () => Promise<boolean>>;
  isShuttingDown: () => boolean;
  /** Per-check timeout. */
  timeoutMs?: number;
}

const startedAt = Date.now();

const withTimeout = async (check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check().catch(() => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** GET /health — liveness only. */
export const getHealth: RequestHandler = (_req, res) => {
  ok(res, { status: 'ok' as const, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) });
};

/** GET /ready — every dependency up and not shutting down, else 503 PROVIDER_UNAVAILABLE. */
export const getReady =
  (deps: ReadinessDeps): RequestHandler =>
  async (_req, res, next) => {
    if (deps.isShuttingDown()) {
      next(
        new AppError('PROVIDER_UNAVAILABLE', 'Service is not ready.', [
          { path: 'server', message: 'shutting down' },
        ]),
      );
      return;
    }
    const names = Object.keys(deps.checks);
    const results = await Promise.all(
      names.map((name) =>
        withTimeout(deps.checks[name] as () => Promise<boolean>, deps.timeoutMs ?? 2000),
      ),
    );
    const down: ErrorDetail[] = names
      .filter((_name, i) => !results[i])
      .map((name) => ({ path: name, message: 'down' }));
    if (down.length) {
      next(new AppError('PROVIDER_UNAVAILABLE', 'Service is not ready.', down));
      return;
    }
    ok(res, {
      status: 'ready' as const,
      checks: Object.fromEntries(names.map((n) => [n, 'up' as const])),
    });
  };
