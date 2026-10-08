import express, { json, Router } from 'express';
import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IdempotencyKeyModel } from '../../src/db/models/idempotency-key.model';
import { ProviderError, ValidationError } from '../../src/shared/errors/app-error';
import { created, noContent } from '../../src/shared/http/envelope';
import { createLogger } from '../../src/shared/logger';
import { errorHandler } from '../../src/shared/middlewares/error-handler';
import { httpLogger } from '../../src/shared/middlewares/http-logger';
import { idempotency } from '../../src/shared/middlewares/idempotency';
import { requestId } from '../../src/shared/middlewares/request-id';
import { startTestMongo } from '../helpers/mongo';

const ACCOUNT = new Types.ObjectId().toString();
const OTHER_ACCOUNT = new Types.ObjectId().toString();
const calls: Record<string, number> = {};
const hit = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);

const buildApp = () => {
  const app = express();
  app.use(requestId());
  app.use(httpLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' })));
  app.use(json());
  const scope = (req: express.Request) => req.get('x-test-account');
  const router = Router();
  router.use('/required', idempotency({ scope }));
  router.use('/optional', idempotency({ scope, required: false }));

  router.post('/required/orders', (req, res) =>
    created(res, { n: hit('orders'), body: req.body as unknown }),
  );
  router.post('/required/slow', async (_req, res) => {
    await new Promise((r) => setTimeout(r, 300));
    created(res, { n: hit('slow') });
  });
  router.post('/required/flaky', (_req, res) => {
    if (hit('flaky') === 1) throw new ProviderError();
    created(res, { ok: true });
  });
  router.post('/required/invalid', () => {
    hit('invalid');
    throw new ValidationError([{ path: 'amount', message: 'too low' }]);
  });
  router.post('/required/empty', (_req, res) => {
    hit('empty');
    noContent(res);
  });
  router.post('/optional/thing', (_req, res) => created(res, { n: hit('optional') }));

  app.use('/api/v1', router);
  app.use(errorHandler());
  return app;
};

describe('idempotency middleware', () => {
  let stop: () => Promise<void>;
  const app = buildApp();
  const post = (
    path: string,
    key: string | undefined,
    body: object = { amount: 100 },
    account = ACCOUNT,
  ) => {
    const r = request(app).post(`/api/v1${path}`).set('x-test-account', account).send(body);
    return key ? r.set('Idempotency-Key', key) : r;
  };

  beforeAll(async () => {
    const mongo = await startTestMongo();
    stop = mongo.stop;
    await mongoose.connect(mongo.uri);
    await IdempotencyKeyModel.syncIndexes();
  });

  afterAll(async () => {
    await stop();
  });

  it('runs the handler once and replays the stored response', async () => {
    const first = await post('/required/orders', 'order-1');
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    const second = await post('/required/orders', 'order-1');
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(calls.orders).toBe(1);
  });

  it('treats key order in the body as the same request', async () => {
    await post('/required/orders', 'order-2', { a: 1, b: 2 });
    const res = await post('/required/orders', 'order-2', { b: 2, a: 1 });
    expect(res.headers['idempotent-replayed']).toBe('true');
  });

  it('rejects the same key with a different body (422 IDEMPOTENCY_KEY_REUSED)', async () => {
    await post('/required/orders', 'order-3', { amount: 1 });
    const res = await post('/required/orders', 'order-3', { amount: 2 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('returns 409 IDEMPOTENCY_IN_PROGRESS while the first request is running', async () => {
    const [a, b] = await Promise.all([
      post('/required/slow', 'slow-1'),
      new Promise((r) => setTimeout(r, 80)).then(() => post('/required/slow', 'slow-1')),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(calls.slow).toBe(1);
  });

  it('does not store 5xx responses, so a retry runs the handler again', async () => {
    const first = await post('/required/flaky', 'flaky-1');
    expect(first.status).toBe(502);
    expect(await IdempotencyKeyModel.countDocuments({ key: 'flaky-1' })).toBe(0);
    const retry = await post('/required/flaky', 'flaky-1');
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });

  it('stores and replays 4xx responses', async () => {
    const first = await post('/required/invalid', 'invalid-1');
    expect(first.status).toBe(422);
    const second = await post('/required/invalid', 'invalid-1');
    expect(second.status).toBe(422);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.error.code).toBe('VALIDATION_FAILED');
    expect(calls.invalid).toBe(1);
  });

  it('stores and replays 204 responses', async () => {
    expect((await post('/required/empty', 'empty-1')).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50)); // 204 is stored on finish
    const second = await post('/required/empty', 'empty-1');
    expect(second.status).toBe(204);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(calls.empty).toBe(1);
  });

  it('requires the header when configured', async () => {
    const res = await post('/required/orders', undefined);
    expect(res.status).toBe(422);
    expect(res.body.error.details).toEqual([
      { path: 'headers.idempotency-key', message: 'Required' },
    ]);
  });

  it('rejects malformed keys', async () => {
    const res = await post('/required/orders', 'bad key with spaces');
    expect(res.status).toBe(422);
  });

  it('passes through without a key in optional mode', async () => {
    expect((await post('/optional/thing', undefined)).status).toBe(201);
    expect((await post('/optional/thing', undefined)).status).toBe(201);
    expect(calls.optional).toBe(2);
  });

  it('scopes keys per account', async () => {
    await post('/required/orders', 'shared-key');
    const other = await post('/required/orders', 'shared-key', { amount: 100 }, OTHER_ACCOUNT);
    expect(other.headers['idempotent-replayed']).toBeUndefined();
  });

  it('has a TTL index on expiresAt and a unique account+key index', async () => {
    const indexes = await IdempotencyKeyModel.collection.indexes();
    expect(indexes.find((i) => i.key.expiresAt === 1)?.expireAfterSeconds).toBe(0);
    expect(indexes.find((i) => i.key.accountId === 1 && i.key.key === 1)?.unique).toBe(true);
  });
});
