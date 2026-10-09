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

const MODELS = path.resolve(__dirname, '../../src/db/models');

/**
 * Collections that are not tenant data (or have a nullable account on purpose).
 * Everything else must declare a required `accountId` (tenantPlugin or explicit).
 */
const NOT_TENANT_SCOPED: Record<string, string> = {
  'account.model.ts': 'the tenant itself',
  'auth-code.model.ts': 'per user (OTP / reset codes keyed by userId)',
  'invoice-counter.model.ts': 'platform-wide GST series per financial year',
  'payment-event.model.ts': 'provider webhooks; accountId nullable until matched',
  'rate-card.model.ts': 'accountId null = platform default card',
  'mock-payment-record.model.ts': 'dev-only mock data; its route is never mounted in production',
};

describe('tenant scoping (models)', () => {
  it('every tenant collection requires accountId', () => {
    const missing = readdirSync(MODELS)
      .filter((f) => f.endsWith('.model.ts') && !(f in NOT_TENANT_SCOPED))
      .filter((f) => {
        const text = readFileSync(path.join(MODELS, f), 'utf8');
        return !/tenantPlugin\)|accountId: \{ type: Schema\.Types\.ObjectId, required: true/.test(
          text,
        );
      });
    expect(missing).toEqual([]);
  });
});
