import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { created, noContent, ok } from './envelope';

const app = express();
app.get('/ok', (_req, res) => ok(res, { a: 1 }));
app.get('/ok-meta', (_req, res) =>
  ok(res, [1, 2], { page: 1, limit: 20, total: 2, totalPages: 1 }),
);
app.post('/created', (_req, res) => created(res, { id: 'x' }));
app.delete('/gone', (_req, res) => noContent(res));

describe('envelope helpers', () => {
  it('ok → 200 without meta', async () => {
    const res = await request(app).get('/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { a: 1 } });
  });

  it('ok → 200 with meta', async () => {
    const res = await request(app).get('/ok-meta');
    expect(res.body).toEqual({
      success: true,
      data: [1, 2],
      meta: { page: 1, limit: 20, total: 2, totalPages: 1 },
    });
  });

  it('created → 201', async () => {
    const res = await request(app).post('/created');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { id: 'x' } });
  });

  it('noContent → 204 empty body', async () => {
    const res = await request(app).delete('/gone');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });
});
