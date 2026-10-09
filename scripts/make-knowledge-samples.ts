/**
 * Generates the sample knowledge documents (`docs/samples/knowledge/`):
 * `npm run samples:knowledge`. Used by the seed ("Demo Finance FAQ"), the
 * Playwright E2E and for trying uploads by hand. Deterministic, safe to commit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { makeDocx, makePdf } from './lib/office';

const OUT = path.resolve(__dirname, '../docs/samples/knowledge');

export const SAMPLE_FAQ = `# Payment methods
Aap apni EMI UPI, NEFT, debit card ya kisi bhi branch par cash se jama kar sakte hain. Hamari UPI ID demofinance@upi hai.
You can pay your EMI by UPI, NEFT, debit card or cash at any branch. Our UPI ID is demofinance@upi.

# Late fee
Due date ke baad har din ₹50 late fee lagti hai, maximum ₹500 tak.
A late fee of ₹50 per day applies after the due date, up to ₹500 per EMI.

# Contact hours
Hamari support team Monday se Saturday, subah 9 baje se shaam 7 baje tak available hai.
Our support team is available Monday to Saturday, 9 am to 7 pm. Call 1800-000-0000 (toll free).

# Payment receipt
Payment ke 24 ghante ke andar SMS par receipt aa jaati hai.
A receipt is sent by SMS within 24 hours of the payment.
`;

export const SAMPLE_POLICY = [
  '# Payment policy',
  'This policy explains how Demo Finance handles EMI payments.',
  '# Grace period',
  'Every EMI has a grace period of 3 days after the due date. No late fee is charged during the grace period.',
  '# Part payments',
  'Part payments are accepted. The remaining amount stays due and the late fee applies only to the unpaid part.',
  '# Promise to pay',
  'A customer may promise to pay within 15 days. The promise is noted and a reminder is sent one day before the promised date.',
];

export const SAMPLE_TERMS = [
  '# Loan terms',
  'Personal loans are given for 12 to 36 months at a fixed interest rate.',
  '# Auto debit',
  'EMIs are collected by auto debit on the 5th of every month. If the auto debit fails, a bounce charge of ₹350 applies.',
  '# Foreclosure',
  'A loan can be closed early after 6 EMIs. Foreclosure charges are 2% of the outstanding principal.',
];

const main = async () => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'faq.txt'), SAMPLE_FAQ);
  writeFileSync(path.join(OUT, 'payment-policy.pdf'), await makePdf(SAMPLE_POLICY));
  writeFileSync(path.join(OUT, 'loan-terms.docx'), makeDocx(SAMPLE_TERMS));
  console.info(`Knowledge samples written to ${OUT}`);
};

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
