import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AriClient } from '../../src/core/telephony/sip/ari-client';
import { SipCapacity } from '../../src/core/telephony/sip/capacity';
import { PortPool } from '../../src/core/telephony/sip/port-pool';
import { SipLineBusyError, SipTelephonyProvider } from '../../src/core/telephony/sip/provider';
import { systemClock } from '../../src/core/voice/clock';
import { CallModel } from '../../src/db/models/call.model';
import { countLiveCalls } from '../../src/ops/live-calls';
import { useTestDb } from '../helpers/db';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

import { FakeAri, waitFor } from './fake-ari';

useTestDb();
let a: Redis;
let b: Redis;
let url: string;
const prefixes: string[] = [];
const prefix = () => {
  const p = `${uniquePrefix('sip-cap')}:`;
  prefixes.push(p);
  return p;
};

beforeAll(async () => {
  ({ url, client: a } = await requireRedis());
  b = new Redis(url);
});
afterAll(async () => {
  for (const p of prefixes) await flushPrefix(a, p);
  a.disconnect();
  b.disconnect();
});

describe('trunk channels and calls per second (T18.8)', () => {
  it('two processes never take more channels than the trunk has', async () => {
    const p = prefix();
    const one = new SipCapacity({ redis: a, prefix: p, maxChannels: 5, maxCps: 100 });
    const two = new SipCapacity({ redis: b, prefix: p, maxChannels: 5, maxCps: 100 });
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => (i % 2 ? one : two).acquire(`call-${String(i)}`)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await one.inUse()).toBe(5);
    const winner = `call-${String(results.indexOf(true))}`;
    expect(await two.acquire(winner)).toBe(true); // the same call again: no second channel
    expect(await one.inUse()).toBe(5);
    await one.release(winner);
    expect(await two.acquire('call-new')).toBe(true);
    expect(await one.acquire('call-newer')).toBe(false);
  });

  it('a lease of a crashed process expires unless refreshed', async () => {
    const p = prefix();
    let now = 1_000_000;
    const cap = new SipCapacity({
      redis: a,
      prefix: p,
      maxChannels: 1,
      maxCps: 9,
      leaseMs: 9000,
      now: () => now,
    });
    expect(cap.refreshEveryMs).toBe(3000);
    expect(await cap.acquire('x')).toBe(true);
    now += 8000;
    await cap.refresh(['x', 'unknown']);
    now += 8000;
    expect(await cap.acquire('y')).toBe(false); // refreshed: still held
    now += 2000;
    expect(await cap.acquire('y')).toBe(true); // expired: free again
    await cap.refresh([]);
  });

  it('calls per second wait for the next second, or give up', async () => {
    const p = prefix();
    let now = 5_000_100;
    const slept: number[] = [];
    const cap = new SipCapacity({
      redis: a,
      prefix: p,
      maxChannels: 9,
      maxCps: 2,
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    expect(await cap.dialToken()).toBe(true);
    expect(await cap.dialToken()).toBe(true);
    expect(await cap.dialToken()).toBe(true);
    expect(slept).toEqual([900]);
    expect(await cap.dialToken(0)).toBe(true);
    expect(await cap.dialToken(0)).toBe(false);
  });

  it('the SIP line refuses when the trunk is full and frees the channel when a call ends', async () => {
    const p = prefix();
    const ari = await new FakeAri().start();
    const client = new AriClient({
      url: ari.url,
      user: 'cav',
      password: 'x'.repeat(24),
      app: 'cav',
    });
    client.connect();
    await waitFor(() => client.connected);
    const cap = new SipCapacity({ redis: a, prefix: p, maxChannels: 1, maxCps: 10, leaseMs: 300 });
    const line = new SipTelephonyProvider(
      client,
      new PortPool(35000, 35009),
      systemClock,
      {
        trunk: 'trunk',
        format: 'ulaw',
        ringTimeoutSec: 40,
        mediaTimeoutSec: 10,
        rtpBindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        asteriskRtpHost: '127.0.0.1',
        defaultCallerId: '+911600000000',
      },
      cap,
    );
    const leg = await line.startCall({ callId: 'c1', to: '+919000000001' });
    await expect(line.startCall({ callId: 'c2', to: '+919000000001' })).rejects.toBeInstanceOf(
      SipLineBusyError,
    );
    // the refresh keeps the lease past its 300 ms life
    await new Promise((r) => setTimeout(r, 450));
    expect(await cap.inUse()).toBe(1);
    await leg.dial();
    ari.send({ type: 'StasisStart', channel: { id: 'cav-c1', state: 'Up' }, args: ['c1'] });
    ari.on((c) =>
      c.path === '/channels/externalMedia'
        ? { status: 200, body: { id: 'cav-c1-em', channelvars: { UNICASTRTP_LOCAL_PORT: '9' } } }
        : undefined,
    );
    await waitFor(() => ari.calls.some((c) => c.path.endsWith('/addChannel')));
    // no free channel for the agent leg either
    expect(await leg.transfer({ phone: '+919000000009', last4: '0009' }, 5)).toBe('failed');
    ari.send({ type: 'ChannelDestroyed', channel: { id: 'cav-c1' }, cause: 16, cause_txt: '' });
    await waitFor(() => leg.ended);
    expect(await cap.inUse()).toBe(0);
    const next = await line.startCall({ callId: 'c3', to: '+919000000001' });
    await next.hangup('normal');
    client.close();
    await ari.stop();
  });

  it('no calls-per-second slot in time: refused, and the channel it took is free again', async () => {
    const p = prefix();
    let now = 7_000_000;
    const clockCap = (maxCps: number) =>
      new SipCapacity({
        redis: a,
        prefix: p,
        maxChannels: 3,
        maxCps,
        now: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
      });
    const ari = await new FakeAri().start();
    const client = new AriClient({
      url: ari.url,
      user: 'cav',
      password: 'x'.repeat(24),
      app: 'cav',
    });
    const line = new SipTelephonyProvider(
      client,
      new PortPool(35010, 35019),
      systemClock,
      {
        trunk: 'trunk',
        format: 'ulaw',
        ringTimeoutSec: 40,
        mediaTimeoutSec: 10,
        rtpBindHost: '127.0.0.1',
        advertiseHost: '127.0.0.1',
        asteriskRtpHost: '127.0.0.1',
        defaultCallerId: '+911600000000',
      },
      clockCap(0),
    );
    await expect(line.startCall({ callId: 'd1', to: '+919000000001' })).rejects.toBeInstanceOf(
      SipLineBusyError,
    );
    expect(await clockCap(0).inUse()).toBe(0);
    await ari.stop();
  });

  it('a release waits for live SIP calls too', async () => {
    const base = {
      accountId: new Types.ObjectId(),
      direction: 'outbound' as const,
      to: '+919000000001',
      source: { kind: 'flow' as const },
      timestamps: { queuedAt: new Date() },
    };
    const before = await countLiveCalls();
    await CallModel.create({
      ...base,
      provider: 'sip',
      from: '+911600000000',
      status: 'in_progress',
    });
    expect(await countLiveCalls()).toBe(before + 1);
  });
});
