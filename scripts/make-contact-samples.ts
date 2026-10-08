/**
 * Writes the Phase 3 sample sheets (fake data) to docs/samples/:
 *   contacts-sample-100.csv / .xlsx — 100 rows with a known mix of problems
 *   dnd-sample.csv                  — 5 do-not-call numbers
 * Run: npm run samples:contacts   (expected totals: docs/samples/README.md)
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';

import writeXlsxFile from 'write-excel-file/node';

const OUT = path.resolve(__dirname, '../docs/samples');
const HEADER = [
  'Name',
  'Mobile No',
  'Email',
  'Loan ID',
  'Loan Amount',
  'Due Date',
  'DPD',
  'Branch',
  'Tags',
];
const BRANCHES = ['Pune', 'Mumbai', 'Delhi', 'Jaipur', 'Indore'];

/** Phones of the 2 rows that match existing contacts and the 2 on the DND list. */
export const SAMPLE_EXISTING_PHONES = ['+919000100086', '+919000100087'];
export const SAMPLE_DND_PHONES = ['+919000100088', '+919000100089'];

const pad = (n: number, w = 3) => String(n).padStart(w, '0');
const dueDate = (i: number) => `${pad((i % 28) + 1, 2)}/${pad((i % 12) + 1, 2)}/2026`;
const amount = (i: number) => {
  const v = 5000 + i * 250;
  // a mix of formats people really send
  return [String(v), `₹${v.toLocaleString('en-IN')}`, `Rs. ${v}`, `${v}.50`][i % 4] ?? String(v);
};

const row = (
  i: number,
  phone: string,
  overrides: Partial<Record<(typeof HEADER)[number], string>> = {},
) => {
  const base: Record<string, string> = {
    Name: `Test Borrower ${pad(i)}`,
    'Mobile No': phone,
    Email: i % 3 === 0 ? `borrower${pad(i)}@example.com` : '',
    'Loan ID': `LN-${pad(i, 4)}`,
    'Loan Amount': amount(i),
    'Due Date': dueDate(i),
    DPD: String((i * 7) % 90),
    Branch: BRANCHES[i % BRANCHES.length] ?? 'Pune',
    Tags: i % 10 === 0 ? 'vip' : '',
    ...overrides,
  };
  return HEADER.map((h) => base[h] ?? '');
};

export const sampleRows = (): string[][] => {
  const rows: string[][] = [];
  let n = 0;
  const next = () => (n += 1);
  // 85 new, valid contacts (+91 90001 00001 … 00085), national format
  for (let i = 1; i <= 85; i += 1) rows.push(row(next(), `90001${pad(i, 5)}`));
  // 2 phones that already exist in the account → updated
  for (const p of SAMPLE_EXISTING_PHONES) rows.push(row(next(), p.replace('+91', '0')));
  // 2 phones on the DND list → imported and flagged
  for (const p of SAMPLE_DND_PHONES) rows.push(row(next(), p));
  // 5 invalid phones
  for (const bad of ['12345', '9.00011E+09', 'call later', '', '+91 12345'])
    rows.push(row(next(), bad));
  // 3 rows without the required loan amount
  for (let i = 0; i < 3; i += 1)
    rows.push(row(next(), `90002${pad(i + 1, 5)}`, { 'Loan Amount': '' }));
  // 3 duplicates of rows 1–3 (formatted differently)
  for (let i = 1; i <= 3; i += 1) rows.push(row(next(), `+91 90001-${pad(i, 5)}`));
  return [HEADER, ...rows];
};

const csv = (rows: string[][]) =>
  `\uFEFF${rows.map((r) => r.map((c) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n')}\r\n`;

const main = async () => {
  const rows = sampleRows();
  writeFileSync(path.join(OUT, 'contacts-sample-100.csv'), csv(rows));
  const xlsx = writeXlsxFile([
    { sheet: 'Borrowers', data: rows.map((r) => r.map((value) => ({ value }))) },
  ] as never) as unknown as { toBuffer(): Promise<Buffer> };
  writeFileSync(path.join(OUT, 'contacts-sample-100.xlsx'), await xlsx.toBuffer());
  writeFileSync(
    path.join(OUT, 'dnd-sample.csv'),
    csv([
      ['Mobile', 'Reason'],
      ...SAMPLE_DND_PHONES.map((p) => [p, 'Customer asked not to be called']),
      ['9000300001', 'Complaint'],
      ['9000300002', ''],
      ['not a number', 'bad row'],
    ]),
  );
  console.info(`Wrote ${rows.length - 1} rows to docs/samples/`);
};

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
