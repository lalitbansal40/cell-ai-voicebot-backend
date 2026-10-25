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

  it('dry-run calls never reach the billing engine (Phase 8: priced, not charged)', () => {
    const dryRun = [
      'modules/calls/virtual-billing.ts',
      'modules/calls/dry-run.ts',
      'core/telephony/dryrun.ts',
      'core/telephony/scenarios.ts',
      'core/voice/scaled-clock.ts',
    ].map((f) => path.join(SRC, f));
    const offenders = dryRun.filter((f) =>
      /billing\/engine|holdForCall|settleCall|chargeUsage|chargeCallUsage/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('WhatsApp message charges (whatsapp_charge) are written by the engine only', () => {
    const engine = readFileSync(path.join(BILLING_CORE, 'engine.ts'), 'utf8');
    for (const fn of [
      'holdForWhatsApp',
      'captureWhatsApp',
      'releaseWhatsApp',
      'chargeWhatsAppLate',
    ]) {
      expect(engine).toContain(`export const ${fn}`);
    }
    expect(engine.match(/type: 'whatsapp_charge'/g)?.length).toBeGreaterThanOrEqual(3);
    const outside = files(SRC)
      .filter((f) => !f.startsWith(BILLING_CORE) && !f.includes(`${path.sep}db${path.sep}`))
      .filter((f) => /type: 'whatsapp_charge'/.test(readFileSync(f, 'utf8')));
    expect(outside.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('WhatsApp call charges (whatsapp_call_charge) move through the engine only (Phase 12)', () => {
    const engine = readFileSync(path.join(BILLING_CORE, 'engine.ts'), 'utf8');
    for (const fn of [
      'holdForWhatsAppCall',
      'extendWhatsAppCallHold',
      'settleWhatsAppCall',
      'releaseWhatsAppCallHold',
    ]) {
      expect(engine).toContain(`export const ${fn}`);
    }
    expect(engine.match(/type: 'whatsapp_call_charge'/g)?.length).toBeGreaterThanOrEqual(3);
    // the seed, dev scripts and calling module read ledger rows, never write them
    const scripts = ['seed-calls-wa.ts', 'dev-calls-wa.ts', 'dev-calls-wa-full.ts'].map((f) =>
      path.resolve(__dirname, '../../scripts', f),
    );
    const offenders = [...files(path.join(SRC, 'modules/whatsapp-calling')), ...scripts].filter(
      (f) => WRITE.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it('has no float arithmetic in the money core', () => {
    const offenders = [...files(BILLING_CORE), path.join(SRC, 'shared/money.ts')].filter((f) =>
      /parseFloat|toFixed\(|\* ?0\.\d/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
