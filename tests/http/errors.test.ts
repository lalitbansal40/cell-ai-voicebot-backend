import express, { json, type Request, type Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { AppError, ConflictError, ValidationError } from '../../src/shared/errors/app-error';
import { createLogger } from '../../src/shared/logger';
import { errorHandler } from '../../src/shared/middlewares/error-handler';
import { httpLogger } from '../../src/shared/middlewares/http-logger';
import { notFound } from '../../src/shared/middlewares/not-found';
import { requestId } from '../../src/shared/middlewares/request-id';

const buildApp = () => {
  const app = express();
  app.use(requestId());
  app.use(httpLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' })));
  app.use(json({ limit: '1kb' }));
  app.get('/validation', () => {
    throw new ValidationError([{ path: 'phone', message: 'Must be an E.164 number' }]);
  });
  app.get('/conflict', async () => {
    await Promise.resolve();
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Campaign already completed');
  });
  app.get('/crash', () => {
    throw new Error('db password=hunter2 leaked in message');
  });
  app.get('/internal-app-error', () => {
    throw new AppError('INTERNAL_ERROR', 'internal detail must not leak');
  });
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  app.use(notFound());
  app.use(errorHandler());
  return app;
};

describe('errorHandler', () => {
  const app = buildApp();

  it('renders AppError with details and request id', async () => {
    const res = await request(app).get('/validation');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Some fields are invalid.',
        details: [{ path: 'phone', message: 'Must be an E.164 number' }],
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('handles rejected async handlers (Express 5)', async () => {
    const res = await request(app).get('/conflict');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
      message: 'Campaign already completed',
    });
  });

  it('hides unknown error messages behind INTERNAL_ERROR', async () => {
    const res = await request(app).get('/crash');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });

  it('never exposes messages of 5xx AppErrors', async () => {
    const res = await request(app).get('/internal-app-error');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Something went wrong. Please try again.');
  });

  it('maps malformed JSON to 400 REQUEST_MALFORMED', async () => {
    const res = await request(app)
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REQUEST_MALFORMED');
  });

  it('maps an oversized body to 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(app)
      .post('/echo')
      .send({ big: 'x'.repeat(2048) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('delegates to next(err) when headers were already sent', () => {
    const err = new Error('late');
    const next = vi.fn();
    const status = vi.fn();
    const res = { headersSent: true, status, json: vi.fn() } as unknown as Response;
    errorHandler()(
      err,
      { id: 'r1', log: { error: vi.fn(), warn: vi.fn() } } as unknown as Request,
      res,
      next,
    );
    expect(next).toHaveBeenCalledWith(err);
    expect(status).not.toHaveBeenCalled();
  });
});

describe('notFound', () => {
  it('returns the 404 envelope for unknown routes', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
      message: 'Route not found',
    });
  });
});
