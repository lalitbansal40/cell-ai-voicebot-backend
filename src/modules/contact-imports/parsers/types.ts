export interface SheetRow {
  /** Row number as the user sees it in the sheet (header = 1). */
  rowNumber: number;
  cells: string[];
}

export interface ParsedSheet {
  header: string[];
  rows: SheetRow[];
  /** `encoding_fallback`, `ragged_rows` … (shown on the mapping screen). */
  warnings: string[];
  /** xlsx: every sheet name; csv: []. */
  sheets: string[];
  sheet: string | null;
}

export type ImportFileType = 'csv' | 'xlsx';
