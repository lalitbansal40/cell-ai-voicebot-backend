import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from './error-codes';

/** Parses `| \`CODE\` | 422 | … |` rows from the conventions doc. */
const docCodes = (): Record<string, number> => {
  const doc = readFileSync(
    path.resolve(__dirname, '../../../docs/conventions/error-codes.md'),
    'utf8',
  );
  const out: Record<string, number> = {};
  for (const match of doc.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*(\d{3})\s*\|/gm)) {
    out[match[1] as string] = Number(match[2]);
  }
  return out;
};

describe('ERROR_CODES ↔ docs/conventions/error-codes.md', () => {
  it('has exactly the same codes and HTTP statuses as the doc', () => {
    const fromCode = Object.fromEntries(
      Object.entries(ERROR_CODES).map(([code, { status }]) => [code, status]),
    );
    expect(fromCode).toEqual(docCodes());
  });

  it('has a non-empty user-safe message for every code', () => {
    for (const { message } of Object.values(ERROR_CODES)) expect(message.length).toBeGreaterThan(5);
  });
});
