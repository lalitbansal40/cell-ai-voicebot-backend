import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { SIGNED_URL_TTL_SEC } from '../../config/limits';
import { NotFoundError, ProviderError } from '../../shared/errors/app-error';

import { assertSafeKey } from './keys';
import type { StorageProvider } from './storage.types';

const isNotFound = (err: unknown): boolean => {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
};

/** Amazon S3 (or compatible) storage — production driver. */
export class S3Storage implements StorageProvider {
  readonly driver = 's3' as const;

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  static fromEnv(env: {
    S3_BUCKET?: string;
    S3_REGION?: string;
    AWS_ACCESS_KEY_ID?: string;
    AWS_SECRET_ACCESS_KEY?: string;
  }): S3Storage {
    const client = new S3Client({
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
      },
    });
    return new S3Storage(client, env.S3_BUCKET ?? '');
  }

  async put(key: string, body: Buffer | Readable, opts: { contentType: string }) {
    assertSafeKey(key);
    try {
      await new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: key, Body: body, ContentType: opts.contentType },
      }).done();
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { key, size: head.ContentLength ?? 0 };
    } catch (err) {
      throw new ProviderError('PROVIDER_ERROR', 'Storage upload failed', { cause: err });
    }
  }

  async get(key: string): Promise<Readable> {
    assertSafeKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return out.Body as Readable;
    } catch (err) {
      if (isNotFound(err)) throw new NotFoundError('File not found');
      throw new ProviderError('PROVIDER_ERROR', 'Storage download failed', { cause: err });
    }
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      throw new ProviderError('PROVIDER_ERROR', 'Storage delete failed', { cause: err });
    }
  }

  async exists(key: string): Promise<boolean> {
    assertSafeKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw new ProviderError('PROVIDER_ERROR', 'Storage lookup failed', { cause: err });
    }
  }

  signedUrl(key: string, opts: { expiresInSec?: number } = {}): Promise<string> {
    assertSafeKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: opts.expiresInSec ?? SIGNED_URL_TTL_SEC,
    });
  }
}
