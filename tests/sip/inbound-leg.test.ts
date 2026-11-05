import { createSocket, type Socket } from 'node:dgram';

import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AriClient } from '../../src/core/telephony/sip/ari-client';
import { SipCapacity } from '../../src/core/telephony/sip/capacity';
import type { SipCallLeg } from '../../src/core/telephony/sip/leg';
import { PortPool } from '../../src/core/telephony/sip/port-pool';
import {
  SipLineBusyError,
  SipTelephonyProvider,
  type IncomingSipCall,
} from '../../src/core/telephony/sip/provider';
import type { HangupCause, LegStatus } from '../../src/core/telephony/types';
import { systemClock } from '../../src/core/voice/clock';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';

import { FakeAri, waitFor } from './fake-ari';

/** Phase 20 (P20-T3): trunk calls into the inbound app — take, answer, refuse, route. */

let ari: FakeAri;
let client: AriClient;
let asterisk: Socket;
let provider: SipTelephonyProvider;
let redis: Redis;
const prefixes: string[] = [];

const CALL = '6650a1b2c3d4e5f6a7b8c9d1';
const CHANNEL = '1730900000.42';

beforeAll(async () => {
  ({ client: redis } = await requireRedis());
});
afterAll(async () => {
  for (const p of prefixes) await flushPrefix(redis, p);
});

beforeEach(async () => {
  ari = await new FakeAri().start();
  asterisk = createSocket('udp4');
  await new Promise<void>((r) => asterisk.bind(0, '127.0.0.1', r));
  ari.on((c) =>
    c.path === '/channels/externalMedia'
      ? {
          status: 200,
          body: {
            id: c.query.channelId,
            channelvars: { UNICASTRTP_LOCAL_PORT: String(asterisk.address().port) },
          },
        }
      : undefined,
  );
  client = new AriClient({
    url: ari.url,
    user: 'cav',
    password: 'x'.repeat(24),
    app: 'cav-api',
    extraApps: ['cav-inbound'],
  });
  client.connect();
  await waitFor(() => client.connected);
  const prefix = `${uniquePrefix('sip-in')}:`;
  prefixes.push(prefix);
  provider = new SipTelephonyProvider(
    client,
    new PortPool(32100, 32199),
    systemClock,
    {
      trunk: 'trunk',
      format: 'ulaw',
      ringTimeoutSec: 40,
      mediaTimeoutSec: 5,
      rtpBindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      asteriskRtpHost: '127.0.0.1',
      defaultCallerId: '+911600000000',
      app: 'cav-api',
    },
    new SipCapacity({ redis, prefix, maxChannels: 2, maxCps: 10, reservedInbound: 1 }),
  );
});

afterEach(async () => {
  client.close();
  asterisk.close();
  await ari.stop();
});

const incoming = (id = CHANNEL, args = ['911600000001', '919000000001']) =>
  ari.send({
    type: 'StasisStart',
    channel: { id, state: 'Ring', caller: { number: '919000000001' } },
    args,
  });

describe('incoming trunk calls (P20-T3)', () => {
  it('subscribes the inbound app on the same socket', () => {
    expect(ari.lastUpgradeQuery?.get('app')).toBe('cav-api,cav-inbound');
  });

  it('hands a new trunk channel to the handler once, then rings, answers and bridges it', async () => {
    const seen: IncomingSipCall[] = [];
    let leg: SipCallLeg | null = null;
    const statuses: [LegStatus, HangupCause | undefined][] = [];
    provider.onIncoming(async (call) => {
      seen.push(call);
      leg = await provider.acceptInbound({
        callId: CALL,
        channelId: call.channelId,
        did: call.did,
      });
      leg.onStatus((s, c) => statuses.push([s, c]));
      await leg.ring();
      await leg.dial();
    });
    incoming();
    incoming(); // a repeated event never makes a second call
    await waitFor(() => statuses.some(([s]) => s === 'answered'));
    expect(seen).toEqual([{ channelId: CHANNEL, did: '911600000001', caller: '919000000001' }]);
    expect(ari.callsTo('POST', `/channels/${CHANNEL}/ring`)).toHaveLength(1);
    expect(ari.callsTo('POST', `/channels/${CHANNEL}/answer`)).toHaveLength(1);
    const setVar = ari.callsTo('POST', `/channels/${CHANNEL}/variable`)[0];
    expect(setVar?.query).toMatchObject({ variable: 'CAV_CALL_ID', value: CALL });
    const add = ari.callsTo('POST', '/bridges/').find((c) => c.path.endsWith('addChannel'));
    expect(add?.query.channel).toBe(`${CHANNEL},cav-${CALL}-em`);
    // events of Asterisk's channel id reach the leg (the caller hangs up)
    ari.send({ type: 'ChannelDestroyed', channel: { id: CHANNEL }, cause: 16, cause_txt: '' });
    await waitFor(() => leg!.ended);
    expect(statuses.at(-1)).toEqual(['ended', 'customer_hangup']);
    expect(provider.live).toBe(0);
  });

  it('refuses with the right reason and frees nothing it did not take', async () => {
    provider.onIncoming((call) => provider.rejectInbound(call.channelId, 'rejected'));
    incoming('1730900000.50');
    await waitFor(() => ari.callsTo('DELETE', '/channels/1730900000.50').length === 1);
    expect(ari.callsTo('DELETE', '/channels/1730900000.50')[0]?.query.reason).toBe('rejected');
  });

  it('no handler (inbound off in this process) → the caller hears unavailable', async () => {
    incoming('1730900000.51');
    await waitFor(() => ari.callsTo('DELETE', '/channels/1730900000.51').length === 1);
    expect(ari.callsTo('DELETE', '/channels/1730900000.51')[0]?.query.reason).toBe('congestion');
  });

  it('a ringing leg refused before the answer ends busy; no answer, no media', async () => {
    let leg: SipCallLeg | null = null;
    provider.onIncoming(async (call) => {
      leg = await provider.acceptInbound({
        callId: CALL,
        channelId: call.channelId,
        did: call.did,
      });
      await leg.reject('busy');
    });
    incoming();
    await waitFor(() => ari.callsTo('DELETE', `/channels/${CHANNEL}`).length === 1);
    ari.send({ type: 'ChannelDestroyed', channel: { id: CHANNEL }, cause: 17, cause_txt: '' });
    await waitFor(() => leg!.ended);
    expect(ari.callsTo('POST', `/channels/${CHANNEL}/answer`)).toHaveLength(0);
    expect(ari.callsTo('POST', '/channels/externalMedia')).toHaveLength(0);
  });

  it('outgoing calls leave the reserved channel to incoming ones', async () => {
    // maxChannels 2, reserved 1: one outgoing call fills the outgoing share
    await provider.startCall({ callId: 'a'.repeat(24), to: '+919000000002', amd: 'off' } as never);
    await expect(
      provider.startCall({ callId: 'b'.repeat(24), to: '+919000000003', amd: 'off' } as never),
    ).rejects.toBeInstanceOf(SipLineBusyError);
    // …but an incoming call still gets the reserved one
    await expect(
      provider.acceptInbound({ callId: CALL, channelId: CHANNEL, did: '911600000001' }),
    ).resolves.toBeDefined();
    await expect(
      provider.acceptInbound({ callId: 'c'.repeat(24), channelId: 'x.1', did: '1' }),
    ).rejects.toBeInstanceOf(SipLineBusyError);
  });
});
