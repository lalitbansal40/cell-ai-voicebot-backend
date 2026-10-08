import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import * as prettier from 'prettier';

import { buildOpenApiDocument } from '../src/openapi';

/**
 * Writes openapi/openapi.json (committed). Output is Prettier-formatted so it is
 * byte-identical on every run — `npm run openapi:check` relies on that.
 */
const main = async (): Promise<void> => {
  const outFile = path.resolve(__dirname, '..', 'openapi', 'openapi.json');
  const document = buildOpenApiDocument();
  const options = (await prettier.resolveConfig(outFile)) ?? {};
  const formatted = await prettier.format(JSON.stringify(document), {
    ...options,
    parser: 'json',
  });
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, formatted);
  console.info(`OpenAPI document written to ${path.relative(process.cwd(), outFile)}`);
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
