import type { Request, Response } from 'express';
import { Types } from 'mongoose';

import { ApiKeyModel } from '../../db/models/api-key.model';
import { ApiRequestLogModel } from '../../db/models/api-request-log.model';
import { getLogger } from '../../shared/logger';
import { ROUTE_TEMPLATE_LOCAL } from '../../shared/middlewares/access';
import { READ_METHODS, type ResolvedApiKey } from '../../shared/middlewares/api-key-auth';

/** Usage counters are flushed at most once per key every 10 s. */
export const USAGE_FLUSH_MS = 10_000;
const USAGE_DAYS = 7;

interface PendingUsage {
  day: string;
  reads: number;
  writes: number;
}
const pending = new Map<string, PendingUsage>();
let timer: NodeJS.Timeout | null = null;

const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** Writes the buffered per-day counters (one or two updates per key). Also on shutdown / in tests. */
export const flushApiKeyUsage = async (): Promise<void> => {
  const batch = [...pending];
  pending.clear();
  for (const [keyId, u] of batch) {
    const _id = new Types.ObjectId(keyId);
    const inc = await ApiKeyModel.updateOne(
      { _id, 'usage.day': u.day },
      { $inc: { 'usage.$.reads': u.reads, 'usage.$.writes': u.writes } },
    );
    if (inc.matchedCount) continue;
    await ApiKeyModel.updateOne(
      { _id, 'usage.day': { $ne: u.day } },
      {
        $push: {
          usage: { $each: [{ day: u.day, reads: u.reads, writes: u.writes }], $slice: -USAGE_DAYS },
        },
      },
    );
  }
};

const countUsage = (keyId: string, write: boolean, at: Date): void => {
  const day = utcDay(at);
  const u = pending.get(keyId);
  if (u && u.day === day) {
    if (write) u.writes += 1;
    else u.reads += 1;
  } else {
    if (u) void flushApiKeyUsage().catch(() => undefined);
    pending.set(keyId, { day, reads: write ? 0 : 1, writes: write ? 1 : 0 });
  }
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      flushApiKeyUsage().catch((err: unknown) =>
        getLogger().warn({ err }, 'api key usage flush failed'),
      );
    }, USAGE_FLUSH_MS);
    timer.unref();
  }
};

/**
 * After the response: one `apiRequestLogs` row (method, route template, status,
 * ms, request id — never ids, query values or bodies) + the day's usage counter.
 */
export const recordKeyRequest = (req: Request, res: Response, key: ResolvedApiKey): void => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const at = new Date();
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    countUsage(key.id, !READ_METHODS.has(req.method), at);
    const route = (res.locals[ROUTE_TEMPLATE_LOCAL] as string | undefined) ?? 'unmatched';
    void ApiRequestLogModel.create({
      accountId: new Types.ObjectId(key.accountId),
      apiKeyId: new Types.ObjectId(key.id),
      method: req.method,
      route,
      status: res.statusCode,
      ms,
      requestId: typeof req.id === 'string' ? req.id : '',
      at,
    }).catch((err: unknown) => getLogger().warn({ err }, 'api request log write failed'));
  });
};
