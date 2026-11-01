/** Writes docs/security/RATE_LIMITS.md from the routes of a built app. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildOpenApiDocument } from '../src/openapi';
import { RATE_LIMIT_EXEMPT } from '../src/shared/http/rate-limit-exempt';
import { listRoutes, renderRateLimits } from '../src/shared/http/route-inventory';
import { buildTestApp } from '../tests/helpers/test-app';

const documented = (doc: { paths?: Record<string, object> }) =>
  Object.entries(doc.paths ?? {}).flatMap(([p, item]) =>
    Object.keys(item).map((method) => ({ method, path: p })),
  );

const app = buildTestApp({ MOCK_APIS_ENABLED: 'false' });
const rows = listRoutes(app, documented(buildOpenApiDocument()));
writeFileSync(
  path.resolve(__dirname, '..', 'docs', 'security', 'RATE_LIMITS.md'),
  renderRateLimits(rows, RATE_LIMIT_EXEMPT),
);
