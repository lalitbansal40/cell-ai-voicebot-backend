import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

/** Path without the query string — queries may contain PII (phone, names). */
const pathOnly = (url: string | undefined): string => (url ?? '').split('?')[0] ?? '';

export interface HttpLoggerOptions {
  /** Paths that are not access-logged (e.g. health checks). */
  ignorePaths?: string[];
}

/** Access log + `req.log` child logger carrying the request id. */
export const httpLogger = (logger: Logger, options: HttpLoggerOptions = {}): RequestHandler => {
  const ignore = new Set(options.ignorePaths ?? []);
  return pinoHttp({
    logger,
    genReqId: (req) => (req as { id?: string }).id ?? '',
    customAttributeKeys: { reqId: 'requestId' },
    autoLogging: { ignore: (req) => ignore.has(pathOnly(req.url)) },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req: { method?: string; url?: string }) => ({
        method: req.method,
        path: pathOnly(req.url),
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    wrapSerializers: false,
    // req.log binds only the request id (not the whole request) — keeps handler logs small.
    quietReqLogger: true,
  });
};
