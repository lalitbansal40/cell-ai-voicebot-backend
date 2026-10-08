import { ValidationError } from '../../shared/errors/app-error';

const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Rejects anything that could escape the storage root or confuse S3:
 * empty, absolute, `..`, backslashes, odd characters, > 512 chars.
 */
export const assertSafeKey = (key: string): string => {
  const invalid =
    !key ||
    key.length > 512 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key
      .split('/')
      .some((seg) => seg === '' || seg === '.' || seg === '..' || !SAFE_SEGMENT.test(seg));
  if (invalid) throw new ValidationError([{ path: 'key', message: 'Invalid storage key' }]);
  return key;
};

/** `accounts/<accountId>/<area>/<id>.<ext>` (ADR 0023 key convention). */
export const storageKey = (parts: {
  accountId: string;
  area: string;
  id: string;
  ext: string;
}): string =>
  assertSafeKey(
    `accounts/${parts.accountId}/${parts.area}/${parts.id}.${parts.ext.replace(/^\./, '')}`,
  );
