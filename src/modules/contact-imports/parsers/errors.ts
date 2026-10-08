import { AppError } from '../../../shared/errors/app-error';

export const IMPORT_FILE_PROBLEMS = {
  unreadable: 'The file could not be read. Save it again as .xlsx or .csv (UTF-8).',
  not_csv: 'This does not look like a CSV file.',
  empty_file: 'The sheet has a header row but no data rows.',
  no_header: 'The first row must contain the column names.',
  too_many_rows: 'A file can have at most 50,000 data rows — split it into smaller files.',
  too_many_columns: 'A file can have at most 100 columns.',
  unsafe_file: 'The file is too large when unpacked and was rejected.',
  sheet_not_found: 'That sheet does not exist in the file.',
} as const;
export type ImportFileProblem = keyof typeof IMPORT_FILE_PROBLEMS;

/** `422 IMPORT_FILE_INVALID` with `details: [{ path: 'file', message }]`. */
export const importFileInvalid = (problem: ImportFileProblem): AppError =>
  new AppError('IMPORT_FILE_INVALID', IMPORT_FILE_PROBLEMS[problem], [
    { path: 'file', message: problem },
  ]);
