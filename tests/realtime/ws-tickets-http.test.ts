import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getEnv } from '../../src/config/env';
import { closeAllRedis, getAppRedis } from '../../src/core/queues/redis';
import { WsTicketService } from '../../src/core/realtime';
import { getLogger } from '../../src/shared/logger';
import { createTestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { requireRedis } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
let viewer: TestUser;

beforeAll(async () => {
  await requireRedis();
  const t = await createTestAccount();
  viewer = await t.addUser('viewer');
});
afterAll(async () => {
  await closeAllRedis();
});

describe('POST /api/v1/ws/tickets', () => {
  it('issues a single-use ticket bound to the caller', async () => {
    const res = await request(app)
      .post('/api/v1/ws/tickets')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.data.ticket).toMatch(/^wst_[\w-]{43}$/);
    expect(Date.parse(res.body.data.expiresAt) - Date.now()).toBeGreaterThan(50_000);
    const tickets = new WsTicketService(getAppRedis(getEnv().REDIS_URL, getLogger()));
    const consumed = await tickets.consume(res.body.data.ticket as string);
    expect(consumed).toMatchObject({
      status: 'ok',
      payload: {
        userId: viewer.user._id.toString(),
        accountId: viewer.user.accountId.toString(),
        channel: 'events',
      },
    });
    expect((await tickets.consume(res.body.data.ticket as string)).status).toBe('invalid');
  });

  it('requires a signed-in user and a valid channel', async () => {
    expect((await request(app).post('/api/v1/ws/tickets').send({})).status).toBe(401);
    const media = await request(app)
      .post('/api/v1/ws/tickets')
      .set('Authorization', `Bearer ${viewer.token}`)
      .send({ channel: 'media' });
    expect(media.status).toBe(422);
  });

  it('limits tickets to 30 per minute per user', async () => {
    const t = await createTestAccount();
    const u = await t.addUser('agent');
    let last = 0;
    for (let i = 0; i < 31; i += 1) {
      last = (
        await request(app)
          .post('/api/v1/ws/tickets')
          .set('Authorization', `Bearer ${u.token}`)
          .send({})
      ).status;
    }
    expect(last).toBe(429);
  });
});
