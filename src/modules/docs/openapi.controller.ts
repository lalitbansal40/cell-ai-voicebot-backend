import type { RequestHandler } from 'express';

import { buildOpenApiDocument } from '../../openapi';

import { buildPublicSpec, type OpenApiDoc } from './public-spec';

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

/**
 * GET /api/v1/openapi.public.json — the public docs page's spec: routes tagged
 * `Public API` only, with the guides (plan §7 #6). Always on, built once.
 */
export const createPublicOpenApiHandler = (serverUrl: string): RequestHandler => {
  let document: OpenApiDoc | undefined;
  return (_req, res) => {
    document ??= buildPublicSpec(buildOpenApiDocument({ serverUrl }) as unknown as OpenApiDoc);
    res.set('Cache-Control', 'no-cache');
    res.json(document);
  };
};
