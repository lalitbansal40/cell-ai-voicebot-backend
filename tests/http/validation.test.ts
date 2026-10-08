import express, { json, Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { created, ok } from '../../src/shared/http/envelope';
import { createLogger } from '../../src/shared/logger';
import { errorHandler } from '../../src/shared/middlewares/error-handler';
import { httpLogger } from '../../src/shared/middlewares/http-logger';
import { requestId } from '../../src/shared/middlewares/request-id';
import { handle, validate } from '../../src/shared/middlewares/validate';
import { z } from '../../src/shared/openapi/zod';
import {
  ObjectIdSchema,
  PaginationQuerySchema,
  PhoneE164Schema,
  strictQuery,
} from '../../src/shared/validation/schemas';

const CreateContactBody = z.object({ name: z.string().min(1), phone: PhoneE164Schema });

const buildApp = () => {
  const app = express();
  app.use(requestId());
  app.use(httpLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' })));
  app.use(json());
  const router = Router();

  router.post(
    '/contacts',
    ...handle({ body: CreateContactBody }, ({ body, res }) =>
      created(res, { name: body.name, phone: body.phone }),
    ),
  );

  router.get(
    '/contacts',
    ...handle({ query: strictQuery(PaginationQuerySchema.shape) }, ({ query, req, res }) =>
      ok(res, { query, raw: req.query }),
    ),
  );

  router.get('/contacts/:id', validate({ params: z.object({ id: ObjectIdSchema }) }), (req, res) =>
    ok(res, req.valid),
  );

  app.use('/api/v1', router);
  app.use(errorHandler());
  return app;
};

describe('validate / handle', () => {
  const app = buildApp();

  it('passes parsed, normalised input to the handler', async () => {
    const res = await request(app)
      .post('/api/v1/contacts')
      .send({ name: 'Lalit', phone: '98765 43210' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ name: 'Lalit', phone: '+919876543210' });
  });

  it('returns 422 with prefixed paths for every invalid field', async () => {
    const res = await request(app).post('/api/v1/contacts').send({ name: '', phone: '123' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path).sort();
    expect(paths).toEqual(['body.name', 'body.phone']);
  });

  it('coerces query params into req.valid and leaves req.query untouched', async () => {
    const res = await request(app).get('/api/v1/contacts?page=2&limit=5');
    expect(res.status).toBe(200);
    expect(res.body.data.query).toEqual({ page: 2, limit: 5 });
    expect(res.body.data.raw).toEqual({ page: '2', limit: '5' });
  });

  it('rejects unknown query params', async () => {
    const res = await request(app).get('/api/v1/contacts?page=1&admin=true');
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].path).toBe('query');
  });

  it('rejects limit > 100', async () => {
    const res = await request(app).get('/api/v1/contacts?limit=500');
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].path).toBe('query.limit');
  });

  it('validates route params', async () => {
    const bad = await request(app).get('/api/v1/contacts/not-an-id');
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('params.id');
    const good = await request(app).get('/api/v1/contacts/66f1c2a9e4b0c1d2e3f4a5b6');
    expect(good.body.data).toEqual({ params: { id: '66f1c2a9e4b0c1d2e3f4a5b6' } });
  });
});
