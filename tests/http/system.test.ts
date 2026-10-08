import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { AppInfoSchema } from '../../src/modules/system/system.schema';
import { buildTestApp } from '../helpers/test-app';

describe('GET /api/v1/system/info', () => {
  const app = buildTestApp();

  it('returns app info in the success envelope', async () => {
    const res = await request(app).get('/api/v1/system/info');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(AppInfoSchema.parse(res.body.data)).toEqual(res.body.data);
    expect(res.body.data.name).toBe('cell-ai-voicebot-backend');
  });

  it('sets X-Request-Id and hides X-Powered-By', async () => {
    const res = await request(app).get('/api/v1/system/info');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('app pipeline', () => {
  const app = buildTestApp();

  it('returns the 404 envelope for unknown routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'RESOURCE_NOT_FOUND', requestId: res.headers['x-request-id'] },
    });
  });

  it('returns 400 REQUEST_MALFORMED for broken JSON', async () => {
    const res = await request(app)
      .post('/api/v1/system/info')
      .set('Content-Type', 'application/json')
      .send('{"oops":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REQUEST_MALFORMED');
  });

  it('only exposes routes under /api/v1', async () => {
    const res = await request(app).get('/system/info');
    expect(res.status).toBe(404);
  });
});
