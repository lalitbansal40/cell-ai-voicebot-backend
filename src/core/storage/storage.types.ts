import type { Readable } from 'node:stream';

/** File storage abstraction (ADR 0023) — local disk in dev, S3 in production. */
export interface StorageProvider {
  readonly driver: 'local' | 's3';
  put(
    key: string,
    body: Buffer | Readable,
    opts: { contentType: string },
  ): Promise<{ key: string; size: number }>;
  /** Throws NotFoundError when the key does not exist. */
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  signedUrl(key: string, opts?: { expiresInSec?: number }): Promise<string>;
}
