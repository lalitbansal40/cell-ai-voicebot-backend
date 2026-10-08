import { parse } from 'csv-parse/sync';
import { decode } from 'iconv-lite';

import { importFileInvalid } from './errors';
import type { SheetRow } from './types';

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** UTF-8 (BOM stripped), or windows-1252 when the bytes are not valid UTF-8. */
export const decodeText = (buffer: Buffer): { text: string; fallback: boolean } => {
  let bytes = buffer;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), fallback: false };
  } catch {
    return { text: decode(bytes, 'windows-1252'), fallback: true };
  }
};

/** Most frequent delimiter on the first line, ignoring quoted parts. */
export const sniffDelimiter = (text: string): string => {
  const end = text.search(/\r?\n/);
  const firstLine = (end === -1 ? text : text.slice(0, end)).replace(/"[^"]*"/g, '');
  let best: string = ',';
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
};

/** CSV bytes → header + rows (row numbers as in the file). */
export const parseCsv = (
  buffer: Buffer,
): { header: string[]; rows: SheetRow[]; warnings: string[] } => {
  if (buffer.includes(0)) throw importFileInvalid('not_csv');
  const { text, fallback } = decodeText(buffer);
  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(text, {
      delimiter: sniffDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      info: true,
    }) as unknown as { record: string[]; info: { lines: number } }[];
  } catch {
    throw importFileInvalid('unreadable');
  }
  const warnings = fallback ? ['encoding_fallback'] : [];
  const [first, ...rest] = records;
  const header = first?.record ?? [];
  const width = header.length;
  let ragged = false;
  const rows: SheetRow[] = [];
  for (const { record, info } of rest) {
    if (record.every((cell) => cell.trim() === '')) continue;
    if (record.length !== width) ragged = true;
    rows.push({ rowNumber: info.lines, cells: record });
  }
  if (ragged) warnings.push('ragged_rows');
  return { header, rows, warnings };
};
