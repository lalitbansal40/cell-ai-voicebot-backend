import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../src');
const BILLING_CORE = path.join(SRC, 'core/billing');

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });

const WRITE =
  /\b(WalletModel|LedgerEntryModel)\s*\.\s*(create|insertMany|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|bulkWrite|deleteOne|deleteMany|findOneAndDelete|replaceOne)\b/;

/** PHASE_4_PROMPT §2 rule 6: wallets / ledger rows change only in src/core/billing. */
describe('money writes (security)', () => {
  it('no code outside src/core/billing writes wallets or ledger rows', () => {
    const offenders = files(SRC)
      .filter((f) => !f.startsWith(BILLING_CORE))
      .filter((f) => !f.includes(`${path.sep}db${path.sep}`)) // models + migrations
      .filter((f) => WRITE.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('has no float arithmetic in the money core', () => {
    const offenders = [...files(BILLING_CORE), path.join(SRC, 'shared/money.ts')].filter((f) =>
      /parseFloat|toFixed\(|\* ?0\.\d/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
