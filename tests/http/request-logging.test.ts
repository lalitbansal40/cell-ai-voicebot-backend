import { Writable } from 'node:stream';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/shared/logger';
import { httpLogger } from '../../src/shared/middlewares/http-logger';
import {
  getRequestId,
  REQUEST_ID_HEADER,
  requestId,
} from '../../src/shared/middlewares/request-id';

const buildApp = (ignorePaths: string[] = []) => {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  const app = express();
  app.use(requestId());
  app.use(
    httpLogger(createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'info' }, stream), { ignorePaths }),
  );
  app.get('/ok', (req, res) => {
    req.log.info({ custom: true }, 'inside handler');
    res.json({ id: req.id });
  });
  app.get('/bad', (_req, res) => {
    res.status(404).json({});
  });
  app.get('/boom', (_req, res) => {
    res.status(500).json({});
  });
  return { app, lines };
};

describe('requestId middleware', () => {
  it('generates an id when none is sent', async () => {
    const res = await request(buildApp().app).get('/ok');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body).toEqual({ id: res.headers['x-request-id'] });
  });

  it('echoes a valid incoming id', async () => {
    const res = await request(buildApp().app).get('/ok').set(REQUEST_ID_HEADER, 'abc-123.x:y');
    expect(res.headers['x-request-id']).toBe('abc-123.x:y');
  });

  it('replaces an unsafe incoming id', async () => {
    const res = await request(buildApp().app).get('/ok').set(REQUEST_ID_HEADER, 'bad id <script>');
    expect(res.headers['x-request-id']).not.toBe('bad id <script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('replaces an over-long incoming id', async () => {
    const res = await request(buildApp().app).get('/ok').set(REQUEST_ID_HEADER, 'a'.repeat(65));
    expect(res.headers['x-request-id']).toHaveLength(36);
  });
});

describe('httpLogger middleware', () => {
  it('tags every line with the request id and never logs the query string', async () => {
    const { app, lines } = buildApp();
    const res = await request(app).get('/ok?phone=%2B919876543210');
    const id = res.headers['x-request-id'];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line.requestId).toBe(id);
    const access = lines.find((l) => l.res !== undefined);
    expect(access?.req).toEqual({ method: 'GET', path: '/ok' });
    expect(JSON.stringify(lines)).not.toContain('9876543210');
  });

  it('logs 4xx as warn and 5xx as error', async () => {
    const { app, lines } = buildApp();
    await request(app).get('/bad');
    await request(app).get('/boom');
    const levels = lines.filter((l) => l.res !== undefined).map((l) => l.level);
    expect(levels).toEqual([40, 50]);
  });

  it('skips ignored paths', async () => {
    const { app, lines } = buildApp(['/ok']);
    await request(app).get('/ok');
    expect(lines.filter((l) => l.res !== undefined)).toHaveLength(0);
  });
});

describe('getRequestId', () => {
  it('returns string ids and ignores other types', () => {
    expect(getRequestId({ id: 'abc' })).toBe('abc');
    expect(getRequestId({ id: 42 })).toBe('');
    expect(getRequestId({})).toBe('');
  });
});
