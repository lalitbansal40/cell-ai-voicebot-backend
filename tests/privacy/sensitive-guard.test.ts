import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const src = path.resolve(__dirname, '..', '..', 'src');
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? files(path.join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')
        ? [path.join(dir, e.name)]
        : [],
  );

/** Reviewed: each reads stored contact variables without showing or using a value. */
const ALLOWLIST = new Set([
  'modules/privacy/sensitive.ts', // the helper itself
  'modules/calls/calls.service.ts', // `c` is a call: its stored copy never holds sensitive values
  'modules/contact-imports/run.job.ts', // `c` is an import row, sealed on write
  'modules/post-call/send.job.ts', // `row` is a queued message, opened through the helper
  'modules/templates/template.service.ts', // `c` is a template's variable list
  'modules/campaigns/audience.ts', // handles `{ $enc }`: mask, kept out of the snapshot
  'modules/contacts/contacts.service.ts', // merges stored forms on update, sealed again on save
  'modules/contact-imports/analyse.ts', // keeps stored forms for required checks
]);

const DIRECT_READ = /\b(?:contact|c|row|found|current|existing|match)\??\.variables\b(?!\s*:)/;

describe('contact variables have one read path', () => {
  it('no file outside the allowlist reads them directly', () => {
    const offenders = files(src)
      .filter((f) => !ALLOWLIST.has(path.relative(src, f)))
      .filter((f) => DIRECT_READ.test(readFileSync(f, 'utf8')))
      .map((f) => path.relative(src, f));
    expect(offenders).toEqual([]);
  });
});
