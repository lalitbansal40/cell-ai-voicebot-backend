import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { CustomFieldModel } from '../../db/models/custom-field.model';
import { open, seal, secretKeys, type SecretKeys } from '../../shared/crypto/secret-box';

/**
 * The one read path and one write path of contact variables (ADR 0047). A field marked
 * sensitive is stored as `{ $enc: 'v2:…' }`, so a database dump doesn't show it. Calls, sends
 * and functions get the real value at run time; lists and API answers get the mask.
 */
export const SENSITIVE_MASK = '••••';
const TEXT_PREFIX = '$enc:';

export type ContactReadPurpose = 'call' | 'send' | 'function' | 'export' | 'view' | 'list';

export interface EncryptedValue {
  $enc: string;
}

type StoredVariables = Map<string, unknown> | Record<string, unknown> | null | undefined;

// derived once per env: a bulk import seals many values
const keysByEnv = new WeakMap<object, SecretKeys>();
const keys = (): SecretKeys => {
  const env = getEnv();
  let found = keysByEnv.get(env);
  if (!found) {
    found = secretKeys(env);
    keysByEnv.set(env, found);
  }
  return found;
};

export const isEncrypted = (value: unknown): value is EncryptedValue =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<EncryptedValue>).$enc === 'string';

export const encryptValue = (value: string | number): EncryptedValue => ({
  $enc: seal(keys(), JSON.stringify(value)),
});

export const decryptValue = (value: EncryptedValue): string | number =>
  JSON.parse(open(keys(), value.$enc)) as string | number;

const entriesOf = (variables: StoredVariables): [string, unknown][] => {
  if (!variables) return [];
  return variables instanceof Map ? [...variables.entries()] : Object.entries(variables);
};

/**
 * Contact variables for one purpose. `list` and `view` show the mask; `view` with `reveal`
 * (the contact page, for someone with `contacts.export`) and the run-time purposes open them.
 */
export const readContactVariables = (
  contact: { variables?: StoredVariables },
  { purpose, reveal = false }: { purpose: ContactReadPurpose; reveal?: boolean },
): Record<string, string | number> => {
  const masked = purpose === 'list' || (purpose === 'view' && !reveal);
  const out: Record<string, string | number> = {};
  for (const [key, value] of entriesOf(contact.variables)) {
    if (isEncrypted(value)) out[key] = masked ? SENSITIVE_MASK : decryptValue(value);
    else if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
};

/** The write path: seals the listed keys; a value that is already sealed stays as it is. */
export const sealContactVariables = <T>(
  variables: Record<string, T>,
  sensitive: ReadonlySet<string>,
): Record<string, T | EncryptedValue> => {
  const out: Record<string, T | EncryptedValue> = {};
  for (const [key, value] of Object.entries(variables)) {
    out[key] =
      sensitive.has(key) && (typeof value === 'string' || typeof value === 'number')
        ? encryptValue(value)
        : value;
  }
  return out;
};

/** Keys of this account's fields marked sensitive. */
export const sensitiveKeys = async (accountId: Types.ObjectId | string): Promise<Set<string>> => {
  const fields = await CustomFieldModel.find({ accountId, sensitive: true })
    .select({ key: 1 })
    .lean<{ key: string }[]>();
  return new Set(fields.map((f) => f.key));
};

/** A copy for storing on a call: sensitive values are left out, run time reads the contact. */
export const withoutSensitive = async (
  accountId: Types.ObjectId | string,
  values: Record<string, string>,
): Promise<Record<string, string>> => {
  const sensitive = await sensitiveKeys(accountId);
  if (!sensitive.size) return values;
  return Object.fromEntries(Object.entries(values).filter(([key]) => !sensitive.has(key)));
};

/** Display values a run keeps in its stored state: sensitive ones become sealed text. */
export const sealTextValues = (
  values: Record<string, string>,
  sensitive: ReadonlySet<string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      sensitive.has(key) && value !== '' && !value.startsWith(TEXT_PREFIX)
        ? `${TEXT_PREFIX}${seal(keys(), value)}`
        : value,
    ]),
  );

/** The reverse of `sealTextValues`, for code about to use the values. */
export const openTextValues = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.startsWith(TEXT_PREFIX) ? open(keys(), value.slice(TEXT_PREFIX.length)) : value,
    ]),
  );

/** For an API answer holding stored values: sealed text never leaves the server. */
export const maskTextValues = (values: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.startsWith(TEXT_PREFIX) ? SENSITIVE_MASK : value,
    ]),
  );
