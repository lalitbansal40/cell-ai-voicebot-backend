import path from 'node:path';

/**
 * Absolute path inside `<repo>/assets` — works from `src/` (tsx) and from
 * `dist/` (`node dist/index.js`): both sit one level below the repo root.
 */
export const assetPath = (...parts: string[]): string =>
  path.resolve(__dirname, '..', '..', 'assets', ...parts);
