import readXlsxFile from 'read-excel-file/node';

import { CONTACT_LIMITS } from '../../../config/limits';

import { importFileInvalid } from './errors';
import type { SheetRow } from './types';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const MAX_ENTRIES = 10_000;

/**
 * Zip-bomb guard: sums the uncompressed sizes from the ZIP central directory
 * (no decompression) and rejects workbooks that would unpack past the limit.
 */
export const assertXlsxSafe = (
  buffer: Buffer,
  maxUncompressed: number = CONTACT_LIMITS.xlsxMaxUncompressedBytes,
): void => {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw importFileInvalid('unreadable');
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entries > MAX_ENTRIES) throw importFileInvalid('unsafe_file');
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw importFileInvalid('unreadable');
    }
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) throw importFileInvalid('unsafe_file'); // ZIP64
    total += size;
    if (total > maxUncompressed) throw importFileInvalid('unsafe_file');
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
};

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** One xlsx cell → text (dates `YYYY-MM-DD`, numbers exactly as stored). */
export const cellText = (cell: unknown): string => {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? '' : isoDate(cell);
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (typeof cell === 'string') return cell;
  if (typeof cell === 'number') return String(cell);
  return '';
};

/** xlsx bytes → sheet names + header + rows of the chosen (default first) sheet. */
export const parseXlsx = async (
  buffer: Buffer,
  sheet?: string | null,
): Promise<{ header: string[]; rows: SheetRow[]; sheets: string[]; sheet: string }> => {
  assertXlsxSafe(buffer);
  let workbook: { sheet: string; data: unknown[][] }[];
  try {
    workbook = await readXlsxFile(buffer, { parseNumber: (s: string) => s });
  } catch {
    throw importFileInvalid('unreadable');
  }
  const sheets = workbook.map((s) => s.sheet);
  const chosen = sheet ? workbook.find((s) => s.sheet === sheet) : workbook[0];
  if (!chosen) throw importFileInvalid(sheet ? 'sheet_not_found' : 'unreadable');
  const [first, ...rest] = chosen.data;
  const rows: SheetRow[] = [];
  rest.forEach((cells, i) => {
    const text = cells.map(cellText);
    if (text.some((c) => c.trim() !== '')) rows.push({ rowNumber: i + 2, cells: text });
  });
  return { header: (first ?? []).map(cellText), rows, sheets, sheet: chosen.sheet };
};
