import { describe, expect, it } from 'vitest';

import { buildPublicSpec, type OpenApiDoc } from '../../src/modules/docs/public-spec';
import { auditPublicSpec, PUBLIC_TAG_ORDER } from '../../src/modules/docs/quality';
import { buildOpenApiDocument } from '../../src/openapi';

/** Flipped to true once every public route is documented (DOCS-T4). */
const QUALITY_ENFORCED = false;

const spec = buildPublicSpec(buildOpenApiDocument() as unknown as OpenApiDoc);

describe.skipIf(!QUALITY_ENFORCED)('public API docs quality (L5–L7)', () => {
  it('every public operation has an id, a description, its scope, examples and the errors', () => {
    const problems = auditPublicSpec(spec)
      .filter((r) => r.problems.length)
      .map((r) => `${r.method} ${r.path}: ${r.problems.join('; ')}`);
    expect(problems).toEqual([]);
  });

  it('the public spec names its server and orders its tags', () => {
    expect((spec.servers as { url: string }[] | undefined)?.[0]?.url).toMatch(/\/api\/v1$/);
    const names = (spec.tags ?? []).map((t) => t.name).filter((n) => n !== 'Public API');
    const order = PUBLIC_TAG_ORDER.filter((t) => names.includes(t));
    expect(names).toEqual(order);
  });
});
