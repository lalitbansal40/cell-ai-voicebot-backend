import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const map = readFileSync(path.join(root, 'docs', 'security', 'DATA_MAP.md'), 'utf8');
const modelDir = path.join(root, 'src', 'db', 'models');

/** The collection name each model file passes to `mongoose.model(name, schema, collection)`. */
const collections = readdirSync(modelDir)
  .filter((f) => f.endsWith('.model.ts'))
  .flatMap((file) => {
    const source = readFileSync(path.join(modelDir, file), 'utf8');
    const names = [...source.matchAll(/mongoose\.model<[^>]*>\(\s*'\w+',\s*\w+,\s*'(\w+)'/g)].map(
      (m) => m[1] ?? '',
    );
    return names.map((name) => ({ file, name }));
  });

describe('docs/security/DATA_MAP.md', () => {
  it('finds the models', () => {
    expect(collections.length).toBeGreaterThanOrEqual(60);
  });

  it('has a row for every collection', () => {
    const missing = collections.filter(({ name }) => !map.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
