import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { onlineUsers, removePresence, touchPresence } from '../../src/core/realtime/presence';
import { requireRedis } from '../helpers/redis';

let redis: Redis;
const account = randomUUID();
beforeAll(async () => {
  ({ client: redis } = await requireRedis());
});
afterAll(async () => {
  await redis.del(`call:presence:${account}`);
});

describe('shared call presence', () => {
  it('keeps other tabs online, expires a crashed node and isolates accounts', async () => {
    await touchPresence(redis, account, 'user1', 'tab1', 1000);
    await touchPresence(redis, account, 'user1', 'tab2', 2000);
    await touchPresence(redis, account, 'user2', 'tab3', 3000);
    expect(await onlineUsers(redis, account, 4000)).toEqual(['user1', 'user2']);
    expect(await onlineUsers(redis, `${account}-other`, 4000)).toEqual([]);
    await removePresence(redis, account, 'user1', 'tab1');
    expect(await onlineUsers(redis, account, 4000)).toEqual(['user1', 'user2']);
    expect(await onlineUsers(redis, account, 92000)).toEqual(['user2']);
    expect(await onlineUsers(redis, account, 93000)).toEqual([]);
    await touchPresence(redis, account, 'user3', 'tab4');
    expect(await onlineUsers(redis, account)).toEqual(['user3']);
  });
});
