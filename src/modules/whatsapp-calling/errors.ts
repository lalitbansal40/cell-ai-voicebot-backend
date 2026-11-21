import {
  isMetaApiError,
  mapCallError,
  PROVIDER_ERROR_TYPES,
  type MetaApiError,
} from '../../core/meta';
import { AppError } from '../../shared/errors/app-error';
import { metaApiError } from '../whatsapp/errors';

/**
 * A failed Graph calling request → our error (PHASE_12_PROMPT §1 mapping). The
 * reason (`details[0].message`) is ours, never Meta's text; non-Meta errors pass through.
 */
export const callError = (
  err: unknown,
  hint?: number | string | null,
  op?: MetaCallOperation,
): unknown => {
  if (!isMetaApiError(err)) return err;
  const mapped = mapCallError(err, hint);
  if (mapped.code === 'META_API_ERROR') return metaApiError(err, op);
  return new AppError(
    mapped.code,
    undefined,
    [
      {
        path: 'meta',
        message: err.detail ?? err.message,
        ...(err.code !== null ? { metaCode: err.code } : {}),
        ...(err.subcode !== null ? { metaSubcode: err.subcode } : {}),
        ...(err.fbtraceId ? { fbtraceId: err.fbtraceId } : {}),
        ...(op ? { op } : {}),
        ...(mapped.reason ? { hint: mapped.reason } : {}),
      },
    ],
    {
      cause: err,
      ...(mapped.retryAfterSec !== null ? { retryAfterSec: mapped.retryAfterSec } : {}),
    },
  );
};

export type MetaCallOperation =
  | 'calls.connect'
  | 'calls.pre_accept'
  | 'calls.accept'
  | 'calls.reject'
  | 'calls.terminate'
  | 'settings.get'
  | 'settings.update'
  | 'permissions.get';

const rawMetaError = (err: unknown): MetaApiError | null =>
  isMetaApiError(err)
    ? err
    : err instanceof AppError && isMetaApiError(err.cause)
      ? err.cause
      : null;

/** Normalizes raw and mapped Graph errors into a panel-safe diagnostic shape. */
export const metaCallErrorOf = (err: unknown, op: MetaCallOperation) => {
  const raw = rawMetaError(err);
  const mapped = err instanceof AppError ? err : null;
  const metaCode = raw?.code ?? null;
  const metaSubcode = raw?.subcode ?? null;
  const details = mapped?.details?.[0] as
    { message?: string; metaCode?: number; metaSubcode?: number; fbtraceId?: string } | undefined;
  return {
    op,
    httpStatus: raw?.status ?? null,
    metaCode: metaCode ?? details?.metaCode ?? null,
    metaSubcode: metaSubcode ?? details?.metaSubcode ?? null,
    type: raw?.type ?? null,
    message:
      raw?.detail ??
      raw?.message ??
      details?.message ??
      (err instanceof Error ? err.name : 'Error'),
    fbtraceId: raw?.fbtraceId ?? details?.fbtraceId ?? null,
    at: new Date(),
  };
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

/** PMC: Meta says the token no longer works (raw or mapped error). */
export const isMetaTokenInvalid = (err: unknown): boolean => {
  const raw = err instanceof AppError && isMetaApiError(err.cause) ? err.cause : err;
  return isMetaApiError(raw) && raw.tokenInvalid;
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
