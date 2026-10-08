import { CONTACT_LIMITS } from '../../../config/limits';

import { parseCsv } from './csv';
import { importFileInvalid } from './errors';
import type { ImportFileType, ParsedSheet } from './types';
import { parseXlsx } from './xlsx';

export * from './errors';
export * from './types';

const columnLetter = (index: number): string => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};

/** Trimmed headers; blank → `Column C`; duplicates → `Name (2)`. */
export const normalizeHeader = (raw: string[]): string[] => {
  const seen = new Map<string, number>();
  return raw.map((cell, i) => {
    const base = cell.replace(/\s+/g, ' ').trim() || `Column ${columnLetter(i)}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
};

/**
 * Any supported sheet → header + data rows, with the import limits applied
 * (PHASE_3_PLAN §1c). Throws `IMPORT_FILE_INVALID` with the reason.
 */
export const parseSheet = async (
  buffer: Buffer,
  fileType: ImportFileType,
  sheet?: string | null,
): Promise<ParsedSheet> => {
  const parsed =
    fileType === 'csv'
      ? { ...parseCsv(buffer), sheets: [] as string[], sheet: null }
      : { ...(await parseXlsx(buffer, sheet)), warnings: [] as string[] };

  const width = Math.max(parsed.header.length, ...parsed.rows.map((r) => r.cells.length), 0);
  if (!parsed.header.some((h) => h.trim() !== '')) throw importFileInvalid('no_header');
  if (width > CONTACT_LIMITS.importMaxColumns) throw importFileInvalid('too_many_columns');
  if (parsed.rows.length === 0) throw importFileInvalid('empty_file');
  if (parsed.rows.length > CONTACT_LIMITS.importMaxRows) throw importFileInvalid('too_many_rows');

  const padded = [...parsed.header, ...Array<string>(width - parsed.header.length).fill('')];
  return {
    header: normalizeHeader(padded),
    rows: parsed.rows.map((r) => ({
      rowNumber: r.rowNumber,
      cells: [...r.cells, ...Array<string>(Math.max(0, width - r.cells.length)).fill('')],
    })),
    warnings: parsed.warnings,
    sheets: parsed.sheets,
    sheet: parsed.sheet,
  };
};

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CSV_MIME = [
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream',
];
const XLSX_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
  'application/zip',
];

/**
 * Extension + MIME + magic bytes (api.md §11). `null` = unsupported (→ 415).
 * Browsers often send CSV as `application/vnd.ms-excel`.
 */
export const detectFileType = (
  fileName: string,
  mimeType: string,
  buffer: Buffer,
): ImportFileType | null => {
  const ext = fileName.toLowerCase().split('.').pop();
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  const zip = buffer.subarray(0, 4).equals(XLSX_MAGIC);
  if (ext === 'xlsx' && XLSX_MIME.includes(mime) && zip) return 'xlsx';
  if (ext === 'csv' && CSV_MIME.includes(mime) && !zip) return 'csv';
  return null;
};
