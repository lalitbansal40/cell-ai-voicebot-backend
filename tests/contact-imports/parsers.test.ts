import { describe, expect, it } from 'vitest';

import {
  detectFileType,
  normalizeHeader,
  parseSheet,
} from '../../src/modules/contact-imports/parsers';
import {
  decodeText,
  parseCsv,
  sniffDelimiter,
} from '../../src/modules/contact-imports/parsers/csv';
import {
  assertXlsxSafe,
  cellText,
  parseXlsx,
} from '../../src/modules/contact-imports/parsers/xlsx';
import { csvBuffer, fakeZip, xlsxBuffer } from '../helpers/import-files';

const problem = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { code: string; details: { message: string }[] }).details[0]?.message;
  }
  return undefined;
};
const asyncProblem = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return (err as { details?: { message: string }[] }).details?.[0]?.message;
  }
  return undefined;
};

describe('CSV', () => {
  it('strips the BOM and falls back to windows-1252 for non-UTF-8 bytes', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toEqual({
      text: 'a',
      fallback: false,
    });
    const latin = csvBuffer([['name'], ['José']], { encoding: 'windows-1252' });
    expect(decodeText(latin)).toEqual({ text: 'name\r\nJosé\r\n', fallback: true });
    expect(parseCsv(latin).warnings).toEqual(['encoding_fallback']);
    expect(parseCsv(csvBuffer([['नाम'], ['आशा']], { bom: true })).rows[0]?.cells).toEqual(['आशा']);
  });

  it.each([
    ['a,b,c\n1,2,3', ','],
    ['a;b;c\n1;2;3', ';'],
    ['a\tb\tc', '\t'],
    ['a|b|c', '|'],
    ['"x,y";z;w', ';'],
    ['single', ','],
  ])('sniffs %j → %j', (text, d) => {
    expect(sniffDelimiter(text)).toBe(d);
  });

  it('keeps quoted commas / newlines, row numbers as in the file, flags ragged rows', () => {
    const text = 'Name,Note\r\n"Verma, Asha","line 1\nline 2"\r\n\r\nRavi\r\n';
    const parsed = parseCsv(Buffer.from(text));
    expect(parsed.header).toEqual(['Name', 'Note']);
    expect(parsed.rows).toEqual([
      { rowNumber: 3, cells: ['Verma, Asha', 'line 1\nline 2'] },
      { rowNumber: 5, cells: ['Ravi'] },
    ]);
    expect(parsed.warnings).toEqual(['ragged_rows']);
    expect(parseCsv(Buffer.from('a,b\n , \n1,2\n')).rows).toHaveLength(1);
  });

  it('rejects binary data and unparseable text', () => {
    expect(problem(() => parseCsv(Buffer.from([0x61, 0x00, 0x62])))).toBe('not_csv');
    expect(problem(() => parseCsv(Buffer.from('a,b\n"never closed,x\n')))).toBe('unreadable');
  });
});

describe('parseSheet limits', () => {
  it('pads rows, names blank / duplicate headers', async () => {
    const sheet = await parseSheet(Buffer.from('Name,,name\nA\n'), 'csv');
    expect(sheet.header).toEqual(['Name', 'Column B', 'name (2)']);
    expect(sheet.rows[0]?.cells).toEqual(['A', '', '']);
    expect(normalizeHeader(['  a   b ', ...Array<string>(27).fill('')]).slice(-1)).toEqual([
      'Column AB',
    ]);
  });

  it.each([
    ['no_header', ' , \nA,B\n'],
    ['empty_file', 'Name,Phone\n'],
    ['too_many_columns', `${Array.from({ length: 101 }, (_, i) => `c${i}`).join(',')}\n1\n`],
  ])('%s', async (reason, text) => {
    expect(await asyncProblem(parseSheet(Buffer.from(text), 'csv'))).toBe(reason);
  });

  it('accepts 50,000 rows and rejects 50,001', async () => {
    const rows = (n: number) => `phone\n${'9000000000\n'.repeat(n)}`;
    expect((await parseSheet(Buffer.from(rows(50_000)), 'csv')).rows).toHaveLength(50_000);
    expect(await asyncProblem(parseSheet(Buffer.from(rows(50_001)), 'csv'))).toBe('too_many_rows');
  });
});

describe('XLSX', () => {
  it('reads sheets, dates (YYYY-MM-DD) and numbers exactly as stored', async () => {
    const buffer = await xlsxBuffer([
      {
        name: 'March',
        rows: [
          ['Name', 'Mobile', 'Due', 'Amount', 'Flag'],
          ['Asha', 9876543210, new Date(Date.UTC(2026, 9, 5)), 12500.5, 'yes'],
          [null, null, null, null, null],
          ['Ravi', '09876500001', null, 0.1, null],
        ],
      },
      { name: 'April', rows: [['Phone'], ['9876500002']] },
    ]);
    const first = await parseXlsx(buffer);
    expect(first.sheets).toEqual(['March', 'April']);
    expect(first.sheet).toBe('March');
    expect(first.header).toEqual(['Name', 'Mobile', 'Due', 'Amount', 'Flag']);
    expect(first.rows).toEqual([
      { rowNumber: 2, cells: ['Asha', '9876543210', '2026-10-05', '12500.5', 'yes'] },
      { rowNumber: 4, cells: ['Ravi', '09876500001', '', '0.1', ''] },
    ]);
    const second = await parseSheet(buffer, 'xlsx', 'April');
    expect(second).toMatchObject({ sheet: 'April', header: ['Phone'], warnings: [] });
    expect(await asyncProblem(parseXlsx(buffer, 'Nope'))).toBe('sheet_not_found');
  });

  it('turns cells into text', () => {
    expect(cellText(true)).toBe('TRUE');
    expect(cellText(false)).toBe('FALSE');
    expect(cellText(new Date('x'))).toBe('');
    expect(cellText(7)).toBe('7');
    expect(cellText({})).toBe('');
    expect(cellText(undefined)).toBe('');
  });

  it('guards against zip bombs and broken zips without unpacking', async () => {
    expect(() => assertXlsxSafe(fakeZip(1000))).not.toThrow();
    expect(problem(() => assertXlsxSafe(fakeZip(60 * 1024 * 1024, 2)))).toBe('unsafe_file');
    expect(problem(() => assertXlsxSafe(fakeZip(0xffffffff)))).toBe('unsafe_file');
    expect(problem(() => assertXlsxSafe(fakeZip(1, 10_001)))).toBe('unsafe_file');
    expect(problem(() => assertXlsxSafe(Buffer.from('PK\x03\x04 not a zip at all, sorry')))).toBe(
      'unreadable',
    );
    const broken = fakeZip(1);
    broken.writeUInt32LE(0x12345678, 30); // corrupt the central directory signature
    expect(problem(() => assertXlsxSafe(broken))).toBe('unreadable');
    expect(await asyncProblem(parseXlsx(fakeZip(10)))).toBe('unreadable');
  });
});

describe('detectFileType', () => {
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]);
  const text = Buffer.from('name,phone');
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  it.each([
    ['march.csv', 'text/csv', text, 'csv'],
    ['MARCH.CSV', 'application/vnd.ms-excel', text, 'csv'],
    ['march.csv', 'text/csv; charset=utf-8', text, 'csv'],
    ['march.xlsx', XLSX, zip, 'xlsx'],
    ['march.xlsx', 'application/octet-stream', zip, 'xlsx'],
    ['march.xls', 'application/vnd.ms-excel', zip, null],
    ['march.xlsx', XLSX, text, null],
    ['march.csv', 'text/csv', zip, null],
    ['march.pdf', 'application/pdf', text, null],
    ['march.csv', 'image/png', text, null],
    ['noext', 'text/csv', text, null],
  ])('%s (%s)', (name, mime, buf, expected) => {
    expect(detectFileType(name, mime, buf)).toBe(expected);
  });
});
