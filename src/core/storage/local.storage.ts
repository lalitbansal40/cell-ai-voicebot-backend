import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { SIGNED_URL_TTL_SEC } from '../../config/limits';
import { NotFoundError, ValidationError } from '../../shared/errors/app-error';

import { assertSafeKey } from './keys';
import { signPath, verifySignature } from './signing';
import type { StorageProvider } from './storage.types';

/** Files under STORAGE_LOCAL_PATH; downloads via signed `/files/<key>?exp=&sig=` URLs. */
export class LocalStorage implements StorageProvider {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(
    rootDir: string,
    private readonly baseUrl: string,
    private readonly key: Buffer,
  ) {
    this.root = path.resolve(rootDir);
  }

  /** Absolute path for a key — guaranteed to stay inside the root. */
  resolve(key: string): string {
    assertSafeKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep))
      throw new ValidationError([{ path: 'key', message: 'Invalid storage key' }]);
    return full;
  }

  async put(key: string, body: Buffer | Readable, _opts: { contentType: string }) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await pipeline(Buffer.isBuffer(body) ? Readable.from([body]) : body, createWriteStream(full));
    return { key, size: (await stat(full)).size };
  }

  async get(key: string): Promise<Readable> {
    const full = this.resolve(key);
    if (!(await this.exists(key))) throw new NotFoundError('File not found');
    return createReadStream(full);
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      return false;
    }
  }

  /** Checks a signed URL's `exp` (unix seconds) and `sig` for a key. */
  verify(
    key: string,
    exp: number,
    sig: string,
    nowSec = Math.floor(Date.now() / 1000),
  ): 'ok' | 'expired' | 'invalid' {
    if (!Number.isInteger(exp) || !/^[a-f0-9]{64}$/.test(sig)) return 'invalid';
    if (!verifySignature(this.key, key, exp, sig)) return 'invalid';
    return exp < nowSec ? 'expired' : 'ok';
  }

  signedUrl(key: string, opts: { expiresInSec?: number } = {}): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + (opts.expiresInSec ?? SIGNED_URL_TTL_SEC);
    const sig = signPath(this.key, key, exp);
    return Promise.resolve(
      `${this.baseUrl.replace(/\/$/, '')}/files/${encodeURI(key)}?exp=${exp}&sig=${sig}`,
    );
  }
}
