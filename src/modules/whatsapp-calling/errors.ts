import { isMetaApiError, mapCallError, PROVIDER_ERROR_TYPES } from '../../core/meta';
import { AppError } from '../../shared/errors/app-error';
import { metaApiError } from '../whatsapp/errors';

/**
 * A failed Graph calling request → our error (PHASE_12_PROMPT §1 mapping). The
 * reason (`details[0].message`) is ours, never Meta's text; non-Meta errors pass through.
 */
export const callError = (err: unknown, hint?: number | string | null): unknown => {
  if (!isMetaApiError(err)) return err;
  const mapped = mapCallError(err, hint);
  if (mapped.code === 'META_API_ERROR') return metaApiError(err);
  return new AppError(
    mapped.code,
    undefined,
    mapped.reason
      ? [
          {
            path: 'meta',
            message: mapped.reason,
            ...(err.code !== null ? { metaCode: err.code } : {}),
          },
        ]
      : undefined,
    {
      cause: err,
      ...(mapped.retryAfterSec !== null ? { retryAfterSec: mapped.retryAfterSec } : {}),
    },
  );
};

/** Runs a Graph call; 613 (rate) retries once after `waitMs`, every error is mapped. */
export const withCallErrors = async <T>(
  fn: () => Promise<T>,
  options: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    if (isMetaApiError(err) && mapCallError(err).retryOnce) {
      await (options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(
        options.waitMs ?? 1_000,
      );
      try {
        return await fn();
      } catch (again) {
        throw callError(again);
      }
    }
    throw callError(err);
  }
};

/**
 * PN (D15): the partner API (managed number) can't do calling for it — its own
 * "unsupported", or a 404 on a calling path. Works on the raw or the mapped error.
 */
export const isPartnerCallingUnsupported = (err: unknown): boolean => {
  const raw = err instanceof AppError && isMetaApiError(err.cause) ? err.cause : err;
  if (err instanceof AppError && err.code === 'WA_PROVIDER_UNSUPPORTED') return true;
  if (!isMetaApiError(raw)) return false;
  return (
    raw.type === PROVIDER_ERROR_TYPES.unsupported ||
    (raw.type === PROVIDER_ERROR_TYPES.error && raw.status === 404)
  );
};
