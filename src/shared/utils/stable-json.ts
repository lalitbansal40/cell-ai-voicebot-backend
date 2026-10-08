import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, so key order never changes the hash. */
export const stableJson = (value: unknown): string => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
};

export const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

/** Fingerprint of a request for Idempotency-Key comparison. */
export const hashRequest = (method: string, path: string, body: unknown): string =>
  sha256(`${method.toUpperCase()} ${path} ${stableJson(body ?? null)}`);
