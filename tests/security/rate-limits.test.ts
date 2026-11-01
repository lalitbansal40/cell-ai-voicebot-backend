import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildOpenApiDocument } from '../../src/openapi';
import { RATE_LIMIT_EXEMPT, RATE_LIMIT_REQUIRED } from '../../src/shared/http/rate-limit-exempt';
import { listRoutes, renderRateLimits } from '../../src/shared/http/route-inventory';
import { buildTestApp } from '../helpers/test-app';

const documented = Object.entries(buildOpenApiDocument().paths ?? {}).flatMap(([p, item]) =>
  Object.keys(item).map((method) => ({ method, path: p })),
);
const rows = listRoutes(buildTestApp({ MOCK_APIS_ENABLED: 'false' }), documented);
const name = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe('rate limit inventory', () => {
  // the WhatsApp routers mount only with their runtime; those routes need a sign-in or a signature
  it('reaches most documented routes', () => {
    expect(rows.length).toBeGreaterThan(documented.length * 0.7);
    expect(rows.find((r) => r.path === '/api/v1/contacts' && r.method === 'GET')).toMatchObject({
      authenticated: true,
    });
  });

  it('a route with no sign-in has a limiter or a written reason', () => {
    const gaps = rows
      .filter((r) => !r.authenticated && !r.limited && !RATE_LIMIT_EXEMPT[name(r)])
      .map(name);
    expect(gaps).toEqual([]);
  });

  it('expensive signed-in routes have their own limiter', () => {
    for (const route of RATE_LIMIT_REQUIRED) {
      expect(rows.find((r) => name(r) === route)?.limited, route).toBe(true);
    }
  });

  it('RATE_LIMITS.md is current (run `npm run gen:rate-limits`)', () => {
    const file = path.resolve(__dirname, '..', '..', 'docs', 'security', 'RATE_LIMITS.md');
    expect(readFileSync(file, 'utf8')).toBe(renderRateLimits(rows, RATE_LIMIT_EXEMPT));
  });
});
