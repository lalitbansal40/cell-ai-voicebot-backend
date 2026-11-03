import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CallModel } from '../../src/db/models/call.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { readSipStatus, type SipStatusEnv } from '../../src/modules/admin/sip-status';
import { bellSuperadmins } from '../../src/ops/health-check';
import { healthIssues } from '../../src/ops/health-rules';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { requireRedis } from '../helpers/redis';

import { FakeAri } from './fake-ari';

useTestDb();
let redis: Redis;
let ari: FakeAri;
beforeAll(async () => {
  redis = (await requireRedis()).client;
  ari = await new FakeAri().start();
});
afterAll(async () => {
  redis.disconnect();
  await ari.stop();
});

const env = (over: Partial<SipStatusEnv> = {}): SipStatusEnv => ({
  TELEPHONY_PROVIDER: 'sip',
  ARI_URL: ari.url,
  ARI_USER: 'cav',
  ARI_PASSWORD: 'x'.repeat(24),
  SIP_TRUNK_ENDPOINT: 'trunk',
  SIP_MAX_CHANNELS: 30,
  SIP_MAX_CPS: 2,
  ...over,
});

const base = {
  mongoPrimary: true,
  queues: {},
  failedBefore: null,
  lastBackupAt: new Date().toISOString(),
  now: new Date(),
};

describe('SIP monitoring (T18.15)', () => {
  it('health rules: ARI down, trunk offline, audio loss', () => {
    expect(healthIssues({ ...base, sip: null })).toEqual([]);
    expect(
      healthIssues({ ...base, sip: { ariConnected: false, trunkOnline: null, avgLossPct: null } }),
    ).toEqual(['sip-ari-down']);
    expect(
      healthIssues({ ...base, sip: { ariConnected: true, trunkOnline: false, avgLossPct: 1 } }),
    ).toEqual(['sip-trunk-offline']);
    expect(
      healthIssues({ ...base, sip: { ariConnected: true, trunkOnline: true, avgLossPct: 7.5 } }),
    ).toEqual(['sip-audio-loss']);
    expect(
      healthIssues({ ...base, sip: { ariConnected: true, trunkOnline: null, avgLossPct: 5 } }),
    ).toEqual([]);
  });

  it('reads Asterisk, the trunk state, channels and the last day of SIP calls', async () => {
    expect(await readSipStatus(env({ TELEPHONY_PROVIDER: 'dryrun' }), redis)).toBeNull();
    ari.on((c) =>
      c.path === '/endpoints/PJSIP/trunk' ? { status: 200, body: { state: 'online' } } : undefined,
    );
    const accountId = new Types.ObjectId();
    const row = (endReason: string, lossPct: number, jitterMs: number) => ({
      accountId,
      direction: 'outbound' as const,
      provider: 'sip' as const,
      from: '+911600000000',
      to: '+919000000001',
      source: { kind: 'flow' as const },
      status: 'completed' as const,
      endReason,
      sip: { lossPct, jitterMs },
      timestamps: { queuedAt: new Date() },
    });
    const now = new Date();
    await CallModel.collection.insertMany([
      { ...row('customer_hangup', 1, 10), createdAt: now },
      { ...row('customer_hangup', 3, 30), createdAt: now },
      { ...row('busy', 0, 0), createdAt: now },
    ]);
    const s = await readSipStatus(env(), redis);
    expect(s).toMatchObject({ ariConnected: true, trunkOnline: true, maxChannels: 30, maxCps: 2 });
    expect(s?.causes24h).toMatchObject({ customer_hangup: 2, busy: 1 });
    expect(s?.avgLossPct).toBeCloseTo(1.3, 1);
    expect(typeof s?.liveChannels).toBe('number');
  });

  it('an unreachable Asterisk is reported as down with an unknown trunk', async () => {
    const s = await readSipStatus(env({ ARI_URL: 'http://127.0.0.1:9' }), redis);
    expect(s).toMatchObject({ ariConnected: false, trunkOnline: null });
  });

  it('rings the superadmins once an hour per problem', async () => {
    const platform = await createTestAccount({ isPlatform: true });
    await platform.addUser('owner', { platformRole: 'superadmin' });
    const key = `sip-ari-down`;
    await redis.del(`health:bell:${key}:${String(Math.floor(Date.now() / 3_600_000))}`);
    expect(await bellSuperadmins([key], redis)).toBe(1);
    expect(await bellSuperadmins([key], redis)).toBe(0);
    expect(
      await NotificationModel.countDocuments({ type: 'sip.trunk_down' }),
    ).toBeGreaterThanOrEqual(1);
    expect(await bellSuperadmins([], redis)).toBe(0);
  });
});
