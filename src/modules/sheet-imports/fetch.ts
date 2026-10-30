import type { Env } from '../../config/env';
import { CONTACT_LIMITS, SHEET_IMPORT_LIMITS } from '../../config/limits';
import { fetchPage, type PageFetch } from '../../core/ai/http-tool';
import { AppError } from '../../shared/errors/app-error';
import { outgoingPolicy } from '../../shared/net/url-guard';
import { parseSheet, type ParsedSheet } from '../contact-imports/parsers';

/** `https://docs.google.com/spreadsheets/d/e/<id>/pub?…output=csv` — "Publish to the web" as CSV. */
export const PUBLISHED_CSV_URL =
  /^https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[A-Za-z0-9_-]{20,200}\/pub\?([^#\s]*&)?output=csv(&[^#\s]*)?$/;

export type SheetFetcher = (url: string) => Promise<PageFetch>;

const invalid = (message: string) =>
  new AppError('SHEET_URL_INVALID', undefined, [{ path: 'url', message }]);

/** Production fetch: the AI-function URL guard (DNS checked, ≤ 2 redirects re-checked), CSV only. */
export const defaultSheetFetcher =
  (env: Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL'>): SheetFetcher =>
  (url) =>
    fetchPage(
      url,
      { policy: outgoingPolicy(env) },
      {
        maxBytes: CONTACT_LIMITS.importMaxBytes,
        timeoutMs: 20_000,
        types: /^text\/(csv|plain)\b/,
        accept: 'text/csv, text/plain;q=0.9',
      },
    );

let current: SheetFetcher | null = null;

/** Tests set a fake fetcher (no network in tests); the server uses the env one. */
export const setSheetFetcher = (fetcher: SheetFetcher | null): void => {
  current = fetcher;
};

/** Checks the URL form (Google's published-CSV link only). */
export const assertSheetUrl = (url: string): void => {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw invalid('Not a valid link');
  }
  if (
    !(SHEET_IMPORT_LIMITS.allowedHosts as readonly string[]).includes(host) ||
    !PUBLISHED_CSV_URL.test(url)
  ) {
    throw invalid('In Google Sheets: File → Share → Publish to web → CSV, then paste that link');
  }
};

/**
 * Downloads and parses the published sheet. A sign-in page (sheet not published),
 * HTML, a file over the import size or more rows than an import allows →
 * 422 SHEET_URL_INVALID with the reason (never the URL or the content).
 */
export const fetchSheet = async (
  env: Parameters<typeof defaultSheetFetcher>[0],
  url: string,
): Promise<{ buffer: Buffer; sheet: ParsedSheet }> => {
  assertSheetUrl(url);
  const res = await (current ?? defaultSheetFetcher(env))(url);
  if (!res.ok) {
    if (res.error === 'unsupported_type')
      throw invalid('The sheet is not published as CSV (a sign-in or web page came back)');
    if (res.error === 'too_large') throw invalid('The sheet is larger than an import allows');
    if (res.error === 'blocked') throw invalid('This address is not allowed');
    throw invalid(`The sheet could not be downloaded (${res.error ?? 'error'})`);
  }
  const sheet = await parseSheet(res.body, 'csv');
  if (sheet.rows.length > CONTACT_LIMITS.importMaxRows)
    throw invalid(`At most ${String(CONTACT_LIMITS.importMaxRows)} rows`);
  return { buffer: res.body, sheet };
};
