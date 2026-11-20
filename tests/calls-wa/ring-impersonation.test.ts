import { describe, expect, it } from 'vitest';

import { onlineUsers, touchPresence } from '../../src/core/realtime/presence';
import {
  clearRingSession,
  impersonationSocketId,
  ringSessionsOf,
  setRingSession,
} from '../../src/core/realtime/ring-sessions';
import { requireRedis } from '../helpers/redis';

/** SAC-T2 (D6): login-as sockets never make the owner "online" for ringing, unless Ring me too. */
describe('ring list and login-as sessions', () => {
  it('an impersonation socket alone rings nobody; Ring me too brings it in; off again', async () => {
    const { client: redis } = await requireRedis();
    const accountId = `acct_ring_${Date.now().toString(36)}`;
    const sid = `imp_ring_${Date.now().toString(36)}`;
    await touchPresence(redis, accountId, 'agent1', 'sock-a');
    await touchPresence(redis, accountId, 'owner1', impersonationSocketId(sid, 'sock-b'));
    expect((await onlineUsers(redis, accountId)).sort()).toEqual(['agent1']);

    await setRingSession(redis, {
      accountId,
      sessionId: sid,
      impersonatorId: 'sa1',
      ttlMs: 60_000,
    });
    expect(await ringSessionsOf(redis, accountId)).toEqual([sid]);
    expect((await onlineUsers(redis, accountId)).sort()).toEqual(['agent1', 'owner1']);

    await clearRingSession(redis, { accountId, sessionId: sid });
    expect(await ringSessionsOf(redis, accountId)).toEqual([]);
    expect((await onlineUsers(redis, accountId)).sort()).toEqual(['agent1']);
    // the owner's own tab still counts
    await touchPresence(redis, accountId, 'owner1', 'sock-c');
    expect((await onlineUsers(redis, accountId)).sort()).toEqual(['agent1', 'owner1']);
    redis.disconnect();
  });
});
