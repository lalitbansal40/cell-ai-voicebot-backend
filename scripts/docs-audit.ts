import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { buildPublicSpec, type OpenApiDoc } from '../src/modules/docs/public-spec';
import { auditMarkdown, auditPublicSpec } from '../src/modules/docs/quality';
import { buildOpenApiDocument } from '../src/openapi';

/** `npm run docs:audit` → docs/api/_audit.md: every public operation and what its docs lack. */
const rows = auditPublicSpec(buildPublicSpec(buildOpenApiDocument() as unknown as OpenApiDoc));
const out = path.resolve(__dirname, '..', 'docs', 'api', '_audit.md');
writeFileSync(out, auditMarkdown(rows));
const bad = rows.filter((r) => r.problems.length).length;
console.log(
  `Public API audit: ${String(rows.length)} operations, ${String(bad)} with problems → ${out}`,
);
