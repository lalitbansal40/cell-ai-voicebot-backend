import { encode } from 'iconv-lite';
import writeXlsxFile from 'write-excel-file/node';

type Cell = string | number | Date | null;

/** CSV bytes; quotes cells when needed. */
export const csvBuffer = (
  rows: (string | number)[][],
  { delimiter = ',', bom = false, encoding = 'utf8' } = {},
): Buffer => {
  const quote = (c: string | number) => {
    const s = String(c);
    return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = rows.map((r) => r.map(quote).join(delimiter)).join('\r\n') + '\r\n';
  const body = encoding === 'utf8' ? Buffer.from(text, 'utf8') : encode(text, 'windows-1252');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
};

/** XLSX bytes; Date cells get a dd/mm/yyyy format. */
export const xlsxBuffer = async (sheets: { name: string; rows: Cell[][] }[]): Promise<Buffer> =>
  (
    writeXlsxFile(
      sheets.map((s) => ({
        sheet: s.name,
        data: s.rows.map((r) =>
          r.map((c) =>
            c instanceof Date
              ? { value: c, format: 'dd/mm/yyyy' }
              : c === null
                ? null
                : { value: c },
          ),
        ),
      })) as never,
    ) as unknown as { toBuffer(): Promise<Buffer> }
  ).toBuffer();

/**
 * A tiny "zip" whose central directory claims one entry of `claimedSize`
 * uncompressed bytes (zip-bomb guard test — no real data).
 */
export const fakeZip = (claimedSize: number, entries = 1): Buffer => {
  const name = Buffer.from('xl/worksheets/sheet1.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  const central: Buffer[] = [];
  for (let i = 0; i < entries; i += 1) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt32LE(claimedSize, 24);
    c.writeUInt16LE(name.length, 28);
    central.push(c, name);
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries, 8);
  eocd.writeUInt16LE(entries, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, centralBuf, eocd]);
};

/** `n` data rows of fake borrowers (phones +9190000xxxxx). */
export const borrowerRows = (n: number): string[][] => [
  ['Name', 'Mobile No', 'Loan Amount', 'Due Date'],
  ...Array.from({ length: n }, (_, i) => [
    `Test Borrower ${String(i + 1).padStart(3, '0')}`,
    `90000${String(i).padStart(5, '0')}`,
    String(1000 + i),
    '05/10/2026',
  ]),
];
