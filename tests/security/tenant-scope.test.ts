import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const MODULES = path.resolve(__dirname, '../../src/modules');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

/** api.md §13: accountId only ever comes from the authenticated context. */
describe('tenant scoping (security)', () => {
  it('never reads accountId from the request body, query or params', () => {
    const offenders = files(MODULES).filter((file) =>
      /\b(body|query|params)\??\.accountId\b|\[['"]accountId['"]\]/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders.map((f) => path.relative(MODULES, f))).toEqual([]);
  });

  it('scans a non-trivial number of module files', () => {
    expect(files(MODULES).length).toBeGreaterThan(10);
  });
});
