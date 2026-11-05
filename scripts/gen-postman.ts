import { writeFileSync } from 'node:fs';
import path from 'node:path';

import * as prettier from 'prettier';

import { buildPostmanCollection } from '../src/modules/docs/postman';
import { buildPublicSpec, type OpenApiDoc } from '../src/modules/docs/public-spec';
import { buildOpenApiDocument } from '../src/openapi';

/** `npm run gen:postman` → openapi/postman.json (committed; `openapi:check` diffs it). */
const main = async () => {
  const collection = buildPostmanCollection(
    buildPublicSpec(
      buildOpenApiDocument({ serverUrl: 'https://wa.notifynow.in' }) as unknown as OpenApiDoc,
    ),
  );
  const out = path.resolve(__dirname, '..', 'openapi', 'postman.json');
  const options = (await prettier.resolveConfig(out)) ?? {};
  writeFileSync(
    out,
    await prettier.format(JSON.stringify(collection), { ...options, parser: 'json' }),
  );
  console.info(`Postman collection written to ${out}`);
};

void main();
