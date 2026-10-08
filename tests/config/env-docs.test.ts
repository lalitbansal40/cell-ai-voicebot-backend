import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENV_KEYS } from '../../src/config/env';

const root = path.resolve(__dirname, '..', '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

/** Every variable in src/config/env.ts must be documented — nothing silently missing. */
describe('env docs stay in sync with src/config/env.ts', () => {
  it('has a sensible key list', () => {
    expect(ENV_KEYS.length).toBeGreaterThan(30);
    expect(ENV_KEYS).toContain('EMAIL_DRIVER');
    expect(ENV_KEYS).toContain('API_DOCS_ENABLED');
  });

  it('lists every variable in .env.example', () => {
    const example = read('.env.example');
    const missing = ENV_KEYS.filter((key) => !new RegExp(`^${key}=`, 'm').test(example));
    expect(missing).toEqual([]);
  });

  it('documents every variable in the README env table', () => {
    const readme = read('README.md');
    const missing = ENV_KEYS.filter((key) => !new RegExp(`^\\|\\s*\`${key}\``, 'm').test(readme));
    expect(missing).toEqual([]);
  });

  it('has no undocumented extras in .env.example', () => {
    const example = read('.env.example');
    const keys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const extra = keys.filter((key) => !(ENV_KEYS as readonly string[]).includes(key ?? ''));
    expect(extra).toEqual([]);
  });
});
