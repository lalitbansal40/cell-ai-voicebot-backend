import type { Logger } from 'pino';

declare global {
  namespace Express {
    interface Request {
      /** Request id (X-Request-Id), set by the requestId middleware. */
      id: string;
      /** Child logger carrying the request id, set by the httpLogger middleware. */
      log: Logger;
      /** Parsed + validated input, set by the validate middleware (Express 5 `req.query` is read-only). */
      valid?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};
