import type { RequestHandler } from 'express';

import { buildOpenApiDocument } from '../../openapi';

/**
 * GET /api/v1/openapi.json — the API contract (ADR 0029). Always on (the
 * public API in Phase 10 needs it; it holds no secrets). Returned raw, not in
 * the success envelope — OpenAPI tools expect a plain document. Built once.
 */
export const createOpenApiHandler = (serverUrl: string): RequestHandler => {
  let document: ReturnType<typeof buildOpenApiDocument> | undefined;
  return (_req, res) => {
    document ??= buildOpenApiDocument({ serverUrl });
    res.set('Cache-Control', 'no-cache');
    res.json(document);
  };
};
