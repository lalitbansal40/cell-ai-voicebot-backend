import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config, OUTPUT_DIR } from './config.ts';

/** Persistent spend tracker (output/spend.json) — enforces POC_MAX_USD across runs. */
const SPEND_FILE = path.join(OUTPUT_DIR, 'spend.json');

interface SpendFile {
  totalUsd: number;
  entries: { at: string; label: string; usd: number }[];
}

const read = (): SpendFile =>
  existsSync(SPEND_FILE)
    ? (JSON.parse(readFileSync(SPEND_FILE, 'utf8')) as SpendFile)
    : { totalUsd: 0, entries: [] };

export class BudgetExceededError extends Error {}

export const spentUsd = (): number => read().totalUsd;

export const assertBudget = (extraUsd = 0): void => {
  const total = spentUsd() + extraUsd;
  if (total > config.maxUsd) {
    throw new BudgetExceededError(
      `PoC budget exceeded: $${total.toFixed(4)} > POC_MAX_USD=$${config.maxUsd}. Raise POC_MAX_USD deliberately to continue.`,
    );
  }
};

export const recordSpend = (label: string, usd: number): void => {
  const data = read();
  data.totalUsd += usd;
  data.entries.push({ at: new Date().toISOString(), label, usd });
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(SPEND_FILE, `${JSON.stringify(data, null, 2)}\n`);
};
