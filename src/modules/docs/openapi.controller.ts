import type { RequestHandler } from 'express';

import { buildOpenApiDocument } from '../../openapi';

import { buildPostmanCollection } from './postman';
import { buildPublicSpec, type OpenApiDoc } from './public-spec';

/**
 * GET /api/v1/openapi.json — the API contract (ADR 0029). Always on. Every route
 * only with `API_DOCS_ENABLED` (off in production): otherwise the public spec, so
 * the internet can't read the dashboard and admin route list. Returned raw, not
 * in the success envelope — OpenAPI tools expect a plain document. Built once.
 */
export const createOpenApiHandler = (serverUrl: string, full: boolean): RequestHandler => {
  let document: unknown;
  return (_req, res) => {
    document ??= full
      ? buildOpenApiDocument({ serverUrl })
      : buildPublicSpec(buildOpenApiDocument({ serverUrl }) as unknown as OpenApiDoc);
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

/**
 * GET /api/v1/postman.json — the public API as a Postman collection (DOCS-T6), with this
 * server as `baseUrl`. Public, built once, cached an hour.
 */
export const createPostmanHandler = (serverUrl: string): RequestHandler => {
  let collection: unknown;
  return (_req, res) => {
    collection ??= buildPostmanCollection(
      buildPublicSpec(buildOpenApiDocument({ serverUrl }) as unknown as OpenApiDoc),
    );
    res.set('Cache-Control', 'public, max-age=3600');
    res.set('Content-Disposition', 'attachment; filename="notifynow-api.postman_collection.json"');
    res.json(collection);
  };
};
