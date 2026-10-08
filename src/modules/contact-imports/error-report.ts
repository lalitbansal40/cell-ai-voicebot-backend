import { stringify } from 'csv-stringify/sync';

/** Cells starting with these are formulas in Excel / Sheets (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Prefixes a `'` so spreadsheet apps show the text instead of running it. */
export const safeCell = (value: string): string =>
  FORMULA_START.test(value) ? `'${value}` : value;

/** Reason codes → words for the people reading the report. */
export const REASON_TEXT: Record<string, string> = {
  phone_missing: 'Phone is missing',
  phone_invalid: 'Phone is not valid',
  phone_lost_digits: 'Phone lost digits in Excel (format the column as Text)',
  email_invalid: 'E-mail is not valid',
  tags_invalid: 'Tags are not valid',
  external_id_taken: 'External id belongs to another contact',
};

export const describeReason = (reason: string): string => {
  if (REASON_TEXT[reason]) return REASON_TEXT[reason];
  const [code, detail] = reason.split(':');
  switch (code) {
    case 'type_invalid':
      return `${detail}: wrong format`;
    case 'too_long':
      return `${detail}: too long`;
    case 'missing_required':
      return `${detail}: required`;
    case 'duplicate_of_row':
      return `Same phone as row ${detail}`;
    case 'duplicate_external_id':
      return `Same external id as row ${detail}`;
    default:
      return reason;
  }
};

/** Error CSV: row number, the original cells, reasons (UTF-8 BOM, injection-safe). */
export const buildErrorReport = (
  header: string[],
  rows: { rowNumber: number; cells: string[]; reasons: string[] }[],
): Buffer => {
  const records = [
    ['row', ...header, 'reasons'],
    ...rows.map((r) => [
      String(r.rowNumber),
      ...header.map((_, i) => safeCell(r.cells[i] ?? '')),
      r.reasons.map(describeReason).join('; '),
    ]),
  ];
  return Buffer.concat([
    Buffer.from('\uFEFF'),
    Buffer.from(stringify(records, { record_delimiter: '\r\n' })),
  ]);
};
