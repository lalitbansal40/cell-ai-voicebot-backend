import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import {
  assertSafeKey,
  createStorage,
  LocalStorage,
  S3Storage,
  signingKey,
  signPath,
  storageKey,
  verifySignature,
} from '../../src/core/storage';
import { contentTypeFor } from '../../src/modules/files/files.controller';
import { createLogger } from '../../src/shared/logger';
import { testEnv } from '../helpers/test-app';

const KEY = signingKey({
  NODE_ENV: 'test',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
});
const streamToString = async (s: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

describe('storage keys', () => {
  it('builds the account key convention', () => {
    expect(storageKey({ accountId: 'acc1', area: 'recordings', id: 'call1', ext: '.wav' })).toBe(
      'accounts/acc1/recordings/call1.wav',
    );
  });

  it.each(['', '/abs/x', '../x', 'a/../../b', 'a//b', 'a\\b', 'a/b c', 'a/./b', 'x'.repeat(513)])(
    'rejects unsafe key %s',
    (key) => {
      expect(() => assertSafeKey(key)).toThrow();
    },
  );
});

describe('signing', () => {
  it('verifies a valid signature and rejects tampering', () => {
    const sig = signPath(KEY, 'a/b.wav', 100);
    expect(verifySignature(KEY, 'a/b.wav', 100, sig)).toBe(true);
    expect(verifySignature(KEY, 'a/c.wav', 100, sig)).toBe(false);
    expect(verifySignature(KEY, 'a/b.wav', 101, sig)).toBe(false);
    expect(verifySignature(KEY, 'a/b.wav', 100, 'abc')).toBe(false);
  });

  it('requires ENCRYPTION_KEY in production and falls back outside it', () => {
    expect(() => signingKey({ NODE_ENV: 'production', ENCRYPTION_KEY: undefined })).toThrow();
    expect(signingKey({ NODE_ENV: 'development', ENCRYPTION_KEY: undefined })).toHaveLength(32);
  });
});

describe('LocalStorage', () => {
  let root: string;
  let storage: LocalStorage;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cav-storage-'));
    storage = new LocalStorage(root, 'http://localhost:5100', KEY);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('puts, gets, checks and deletes a Buffer', async () => {
    const key = 'accounts/a1/imports/f1.csv';
    expect(
      await storage.put(key, Buffer.from('name,phone\n'), { contentType: 'text/csv' }),
    ).toEqual({ key, size: 11 });
    expect(await storage.exists(key)).toBe(true);
    expect(await streamToString(await storage.get(key))).toBe('name,phone\n');
    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('accepts streams', async () => {
    const key = 'accounts/a1/audio/s1.txt';
    await storage.put(key, Readable.from(['hello ', 'world']), { contentType: 'text/plain' });
    expect(await streamToString(await storage.get(key))).toBe('hello world');
  });

  it('throws NotFoundError for missing files', async () => {
    await expect(storage.get('accounts/a1/none.txt')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });

  it('rejects path traversal', async () => {
    await expect(
      storage.put('../escape.txt', Buffer.from('x'), { contentType: 'text/plain' }),
    ).rejects.toThrow();
    await expect(storage.exists('a/../../etc/passwd')).rejects.toThrow();
  });

  it('signs URLs that verify, and expire', async () => {
    const url = new URL(await storage.signedUrl('accounts/a1/x.wav', { expiresInSec: 60 }));
    expect(url.pathname).toBe('/files/accounts/a1/x.wav');
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig') ?? '';
    expect(storage.verify('accounts/a1/x.wav', exp, sig)).toBe('ok');
    expect(storage.verify('accounts/a1/x.wav', exp, sig, exp + 1)).toBe('expired');
    expect(storage.verify('accounts/a1/y.wav', exp, sig)).toBe('invalid');
  });
});

describe('GET /files/*key (local driver)', () => {
  let root: string;
  let storage: LocalStorage;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cav-files-'));
    storage = new LocalStorage(root, 'http://localhost:5100', KEY);
    const env = testEnv();
    app = createApp({ env, logger: createLogger(env), storage });
    await storage.put('accounts/a1/recordings/c1.wav', Buffer.from('RIFF-fake'), {
      contentType: 'audio/wav',
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const pathOf = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };

  it('streams a file for a valid signed URL with content type and cache headers', async () => {
    const res = await request(app)
      .get(pathOf(await storage.signedUrl('accounts/a1/recordings/c1.wav', { expiresInSec: 120 })))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toMatch(/^private, max-age=\d+$/);
    expect((res.body as Buffer).toString()).toBe('RIFF-fake');
  });

  it('rejects a tampered signature with 403', async () => {
    const url = await storage.signedUrl('accounts/a1/recordings/c1.wav');
    const res = await request(app).get(pathOf(url).replace(/sig=[a-f0-9]{4}/, 'sig=0000'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_FORBIDDEN');
  });

  it('rejects an expired link with 403', async () => {
    const res = await request(app).get(
      pathOf(await storage.signedUrl('accounts/a1/recordings/c1.wav', { expiresInSec: -10 })),
    );
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('This link has expired.');
  });

  it('returns 404 for a signed URL to a missing file', async () => {
    const res = await request(app).get(
      pathOf(await storage.signedUrl('accounts/a1/recordings/missing.wav')),
    );
    expect(res.status).toBe(404);
  });

  it('is not mounted when no local storage is configured', async () => {
    const env = testEnv();
    const plain = createApp({ env, logger: createLogger(env) });
    expect(
      (await request(plain).get('/files/accounts/a1/recordings/c1.wav?exp=1&sig=x')).status,
    ).toBe(404);
  });

  it('maps content types by extension', () => {
    expect(contentTypeFor('a.mp3')).toBe('audio/mpeg');
    expect(contentTypeFor('a.XLSX')).toContain('spreadsheetml');
    expect(contentTypeFor('a.bin')).toBe('application/octet-stream');
  });
});

describe('S3Storage (mocked client)', () => {
  const client = new S3Client({
    region: 'ap-south-1',
    credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'test-secret' },
  });
  const storage = new S3Storage(client, 'cav-test-bucket');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads and reports the size', async () => {
    const send = vi
      .spyOn(client, 'send')
      .mockImplementation(((cmd: { constructor: { name: string } }) =>
        Promise.resolve(
          cmd.constructor.name === 'HeadObjectCommand' ? { ContentLength: 5 } : {},
        )) as never);
    expect(
      await storage.put('accounts/a/x.txt', Buffer.from('hello'), { contentType: 'text/plain' }),
    ).toEqual({
      key: 'accounts/a/x.txt',
      size: 5,
    });
    expect(send.mock.calls.map(([c]) => (c as object).constructor.name)).toContain(
      'PutObjectCommand',
    );
  });

  it('maps NoSuchKey to NotFoundError and other failures to ProviderError', async () => {
    vi.spyOn(client, 'send').mockRejectedValueOnce(
      Object.assign(new Error('missing'), { name: 'NoSuchKey' }),
    );
    await expect(storage.get('accounts/a/none.txt')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    vi.spyOn(client, 'send').mockRejectedValueOnce(new Error('boom'));
    await expect(storage.delete('accounts/a/x.txt')).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  it('exists() → false on 404, true otherwise', async () => {
    vi.spyOn(client, 'send').mockRejectedValueOnce(
      Object.assign(new Error('nf'), { $metadata: { httpStatusCode: 404 } }),
    );
    expect(await storage.exists('accounts/a/none.txt')).toBe(false);
    vi.spyOn(client, 'send').mockResolvedValueOnce({} as never);
    expect(await storage.exists('accounts/a/x.txt')).toBe(true);
  });

  it('creates presigned GET URLs containing the key', async () => {
    const url = await storage.signedUrl('accounts/a/x.wav', { expiresInSec: 60 });
    expect(url).toContain('cav-test-bucket');
    expect(url).toContain('accounts/a/x.wav');
    expect(url).toContain('X-Amz-Expires=60');
  });

  it('createStorage picks the driver from env', () => {
    expect(createStorage(testEnv()).driver).toBe('local');
    expect(
      createStorage(
        testEnv({
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'b',
          S3_REGION: 'ap-south-1',
          AWS_ACCESS_KEY_ID: 'k',
          AWS_SECRET_ACCESS_KEY: 's',
        }),
      ).driver,
    ).toBe('s3');
  });
});
