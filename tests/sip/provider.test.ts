import { createSocket, type Socket } from 'node:dgram';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AriClient } from '../../src/core/telephony/sip/ari-client';
import { Q850_TEXT, toHangupCause } from '../../src/core/telephony/sip/causes';
import type { SipCallLeg } from '../../src/core/telephony/sip/leg';
import { PortPool } from '../../src/core/telephony/sip/port-pool';
import {
  callIdOfChannel,
  SipNoMediaPortError,
  SipTelephonyProvider,
} from '../../src/core/telephony/sip/provider';
import { buildRtp, parseRtp } from '../../src/core/telephony/sip/rtp-packet';
import type { HangupCause, LegStatus } from '../../src/core/telephony/types';
import { encodeMulaw } from '../../src/core/voice/audio/g711';
import { rms, tone } from '../../src/core/voice/audio/pcm';
import { systemClock } from '../../src/core/voice/clock';
import { endReasonFor, finalStatus } from '../../src/modules/calls/lifecycle';

import { FakeAri, waitFor } from './fake-ari';

let ari: FakeAri;
let client: AriClient;
let asterisk: Socket;
let asteriskGot: Buffer[];
let provider: SipTelephonyProvider;
let pool: PortPool;

const CALL = '6650a1b2c3d4e5f6a7b8c9d0';
const ID = `cav-${CALL}`;

beforeEach(async () => {
  ari = await new FakeAri().start();
  asterisk = createSocket('udp4');
  await new Promise<void>((r) => asterisk.bind(0, '127.0.0.1', r));
  asteriskGot = [];
  asterisk.on('message', (m) => asteriskGot.push(m));
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
  client = new AriClient({ url: ari.url, user: 'cav', password: 'x'.repeat(24), app: 'cav' });
  client.connect();
  await waitFor(() => client.connected);
  pool = new PortPool(32000, 32099);
  provider = new SipTelephonyProvider(client, pool, systemClock, {
    trunk: 'trunk',
    format: 'ulaw',
    ringTimeoutSec: 40,
    mediaTimeoutSec: 1,
    rtpBindHost: '127.0.0.1',
    advertiseHost: '127.0.0.1',
    asteriskRtpHost: '127.0.0.1',
    defaultCallerId: '+911600000000',
  });
});

afterEach(async () => {
  client.close();
  asterisk.close();
  await ari.stop();
});

const watch = (leg: SipCallLeg) => {
  const statuses: [LegStatus, HangupCause | undefined][] = [];
  leg.onStatus((s, c) => statuses.push([s, c]));
  return statuses;
};

const answer = async (leg: SipCallLeg, args: string[] = [CALL]) => {
  ari.send({ type: 'ChannelStateChange', channel: { id: ID, state: 'Ringing' } });
  ari.send({ type: 'StasisStart', channel: { id: ID, state: 'Up' }, args });
  await waitFor(() => leg.ended || watchAnswered(leg));
};

const destroyed = (cause: number, id = ID) =>
  ari.send({ type: 'ChannelDestroyed', channel: { id }, cause, cause_txt: '' });

describe('SIP causes (T18.5)', () => {
  const end = (q850: number | null, extra: Partial<Parameters<typeof toHangupCause>[0]> = {}) =>
    toHangupCause({
      q850,
      dialStatus: null,
      answered: false,
      ourHangup: false,
      amd: null,
      ...extra,
    });

  it('maps Q.850 causes before the answer', () => {
    expect([17, 18, 19, 20, 21, 1, 3, 22, 28, 34, 38, 41, 42, 27].map((c) => end(c))).toEqual([
      'busy',
      'no_answer',
      'no_answer',
      'no_answer',
      'rejected',
      'invalid_number',
      'invalid_number',
      'invalid_number',
      'invalid_number',
      'media_error',
      'media_error',
      'media_error',
      'media_error',
      'media_error',
    ]);
  });

  it('falls back to the dial status, then to no answer / failure', () => {
    expect(end(null, { dialStatus: 'BUSY' })).toBe('busy');
    expect(end(null, { dialStatus: 'NOANSWER' })).toBe('no_answer');
    expect(end(null, { dialStatus: 'CHANUNAVAIL' })).toBe('media_error');
    expect(end(16)).toBe('no_answer');
    expect(end(16, { ourHangup: true })).toBe('normal');
    expect(end(99)).toBe('media_error');
    expect(end(null)).toBe('media_error');
  });

  it('after the answer: who hung up, and a machine', () => {
    expect(end(16, { answered: true })).toBe('customer_hangup');
    expect(end(null, { answered: true })).toBe('customer_hangup');
    expect(end(16, { answered: true, ourHangup: true })).toBe('normal');
    expect(end(41, { answered: true })).toBe('media_error');
    expect(end(16, { answered: true, amd: 'MACHINE' })).toBe('machine');
    expect(Q850_TEXT[17]).toBe('Busy');
  });

  it('a machine ends the call as not answered (retried like no answer)', () => {
    expect(endReasonFor('machine')).toBe('machine');
    expect(finalStatus('machine', false)).toBe('no_answer');
  });

  it('reads the call id from channel ids', () => {
    expect(callIdOfChannel(ID)).toBe(CALL);
    expect(callIdOfChannel(`${ID}-em`)).toBe(CALL);
    expect(callIdOfChannel(`${ID}-xfer`)).toBe(CALL);
    expect(callIdOfChannel('PJSIP/trunk-0001')).toBeNull();
  });
});

describe('SIP line over the fake ARI (T18.5)', () => {
  it('dials with the call id as channel id and the caller id, then answers into a bridge', async () => {
    const leg = await provider.startCall({
      callId: CALL,
      to: '+919000000001',
      callerId: '+911600000001',
    });
    const statuses = watch(leg);
    expect(leg.rate).toBe(8000);
    await leg.dial();
    const orig = ari.callsTo('POST', `/channels/${ID}`)[0]!;
    expect(orig.query).toMatchObject({
      endpoint: 'PJSIP/+919000000001@trunk',
      callerId: '+911600000001',
      app: 'cav',
      appArgs: CALL,
    });
    await answer(leg);
    await waitFor(() => statuses.some(([s]) => s === 'answered'));
    expect(statuses.map(([s]) => s)).toEqual(['ringing', 'answered']);
    const em = ari.callsTo('POST', '/channels/externalMedia')[0]!;
    expect(em.query.external_host).toMatch(/^127\.0\.0\.1:320\d\d$/);
    expect(ari.callsTo('POST', `/bridges/${ID}-br/addChannel`)[0]?.query.channel).toBe(
      `${ID},${ID}-em`,
    );
    expect(provider.live).toBe(1);
    expect(provider.has(CALL)).toBe(true);
  });

  it('carries audio both ways and receives DTMF', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    const heard: Int16Array[] = [];
    const sent: Int16Array[] = [];
    const digits: string[] = [];
    leg.onAudio((f) => heard.push(f));
    leg.onOutgoing((f) => sent.push(f));
    leg.onDtmf((d) => digits.push(d));
    await leg.dial();
    await answer(leg);
    await waitFor(() => watchAnswered(leg));
    const played = leg.play(tone(100, 8000));
    expect(leg.playing).toBe(true);
    expect(await played).toEqual({ completed: true, playedMs: 100 });
    await waitFor(() => asteriskGot.length === 5);
    expect(parseRtp(asteriskGot[0]!)?.payloadType).toBe(0);
    expect(sent).toHaveLength(5);
    const port = Number(
      ari.callsTo('POST', '/channels/externalMedia')[0]!.query.external_host!.split(':')[1],
    );
    const pcm = tone(20, 8000);
    asterisk.send(
      buildRtp({
        payloadType: 0,
        marker: true,
        seq: 1,
        timestamp: 0,
        ssrc: 5,
        payload: encodeMulaw(pcm),
      }),
      port,
      '127.0.0.1',
    );
    await waitFor(() => heard.length === 1);
    expect(rms(heard[0]!)).toBeGreaterThan(1000);
    ari.send({ type: 'ChannelDtmfReceived', channel: { id: ID }, digit: '5', duration_ms: 100 });
    await waitFor(() => digits.length === 1);
    expect(digits).toEqual(['5']);
    expect(leg.metrics).toMatchObject({ codec: 'ulaw', packetsIn: 1, packetsOut: 5 });
    expect(leg.metrics.firstAudioMs).not.toBeNull();
  });

  it.each([
    [17, 'busy'],
    [19, 'no_answer'],
    [21, 'rejected'],
    [1, 'invalid_number'],
    [34, 'media_error'],
  ] as const)('ends before the answer with Q.850 %i → %s and frees the port', async (q, cause) => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000002' });
    const statuses = watch(leg);
    await leg.dial();
    destroyed(q);
    await waitFor(() => leg.ended);
    expect(statuses.at(-1)).toEqual(['ended', cause]);
    expect(pool.leased).toBe(0);
    expect(provider.live).toBe(0);
  });

  it('a customer hangup after the answer ends customer_hangup and cleans up media', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    const statuses = watch(leg);
    await leg.dial();
    await answer(leg);
    ari.send({ type: 'ChannelHangupRequest', channel: { id: ID }, cause: 16 });
    destroyed(16);
    await waitFor(() => leg.ended);
    expect(statuses.at(-1)).toEqual(['ended', 'customer_hangup']);
    await waitFor(() => ari.callsTo('DELETE', `/bridges/${ID}-br`).length === 1);
    expect(ari.callsTo('DELETE', `/channels/${ID}-em`)).toHaveLength(1);
    expect(leg.metrics.sipQ850).toBe(16);
  });

  it('our hangup keeps our cause; a second hangup does nothing', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    const statuses = watch(leg);
    await leg.dial();
    await answer(leg);
    const done = leg.hangup('limit');
    await leg.hangup('normal');
    await done;
    expect(ari.callsTo('DELETE', `/channels/${ID}`)[0]?.query).toEqual({ reason: 'congestion' });
    destroyed(16);
    await waitFor(() => leg.ended);
    expect(statuses.at(-1)).toEqual(['ended', 'limit']);
  });

  it('ends after 2 s when the hangup is never confirmed (ARI gone)', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    await leg.dial();
    await answer(leg);
    ari.on((c) => (c.method === 'DELETE' ? { status: 500 } : undefined));
    await leg.hangup('normal');
    expect(leg.ended).toBe(false);
    await waitFor(() => leg.ended, 3000);
  });

  it('a hangup before dialing ends at once; a failed originate ends media_error', async () => {
    const a = await provider.startCall({ callId: CALL, to: '+919000000001' });
    const sa = watch(a);
    await a.hangup('campaign_canceled' as HangupCause);
    expect(sa.at(-1)?.[0]).toBe('ended');
    await a.dial();
    expect(ari.callsTo('POST', `/channels/${ID}`)).toHaveLength(0);
    ari.on((c) => (c.path.startsWith('/channels/cav-b') ? { status: 500 } : undefined));
    const b = await provider.startCall({ callId: 'b', to: '+919000000001' });
    const sb = watch(b);
    await b.dial();
    expect(sb.at(-1)).toEqual(['ended', 'media_error']);
  });

  it('hangs up media_error when the media setup fails', async () => {
    ari.on((c) =>
      c.path === '/bridges/' + `${ID}-br` && c.method === 'POST' ? { status: 500 } : undefined,
    );
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    const statuses = watch(leg);
    await leg.dial();
    ari.send({ type: 'StasisStart', channel: { id: ID, state: 'Up' }, args: [CALL] });
    await waitFor(() => ari.callsTo('DELETE', `/channels/${ID}`).length === 1);
    destroyed(16);
    await waitFor(() => leg.ended);
    expect(statuses.at(-1)).toEqual(['ended', 'media_error']);
  });

  it('ends media_timeout when no audio arrives for the timeout', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    await leg.dial();
    await answer(leg);
    await waitFor(() => ari.callsTo('DELETE', `/channels/${ID}`).length === 1, 4000);
    expect(ari.callsTo('DELETE', `/channels/${ID}`)[0]?.query).toEqual({ reason: 'normal' });
    destroyed(16);
    const statuses = watch(leg);
    await waitFor(() => leg.ended);
    expect(statuses.at(-1)).toEqual(['ended', 'media_timeout']);
  });

  it('barge-in clears queued audio and nothing plays after the end', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    await leg.dial();
    await answer(leg);
    const p = leg.play(tone(1000, 8000));
    await new Promise((r) => setTimeout(r, 50));
    expect(leg.clearAudio()).toBeGreaterThan(0);
    expect((await p).completed).toBe(false);
    destroyed(16);
    await waitFor(() => leg.ended);
    expect(await leg.play(tone(100, 8000))).toEqual({ completed: false, playedMs: 0 });
  });

  it('runs answering machine detection in the dialplan and hangs up on a machine', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000006', amd: 'hangup' });
    const statuses = watch(leg);
    await leg.dial();
    expect(ari.callsTo('POST', `/channels/${ID}`)[0]?.query).toMatchObject({
      context: 'cav-amd',
      extension: 's',
    });
    ari.send({
      type: 'StasisStart',
      channel: { id: ID, state: 'Up' },
      args: ['amd', 'MACHINE', 'LONGGREETING-1600-1500'],
    });
    await waitFor(() => ari.callsTo('DELETE', `/channels/${ID}`).length === 1);
    destroyed(16);
    await waitFor(() => leg.ended);
    expect(statuses.map(([s]) => s)).toEqual(['ended']);
    expect(statuses.at(-1)?.[1]).toBe('machine');
    expect(leg.metrics).toMatchObject({ amd: 'MACHINE', amdCause: 'LONGGREETING-1600-1500' });
    expect(leg.metrics.amdMs).not.toBeNull();
  });

  it('answers a person after detection, and lets the bot speak on a machine with leave_message', async () => {
    const human = await provider.startCall({ callId: CALL, to: '+919000000008', amd: 'hangup' });
    await human.dial();
    await answer(human, ['amd', 'HUMAN', 'HUMAN-1-1']);
    await waitFor(() => watchAnswered(human));
    destroyed(16);
    await waitFor(() => human.ended);
    const machine = await provider.startCall({
      callId: 'm1',
      to: '+919000000006',
      amd: 'leave_message',
    });
    await machine.dial();
    ari.send({
      type: 'StasisStart',
      channel: { id: 'cav-m1', state: 'Up' },
      args: ['amd', 'MACHINE', 'X'],
    });
    await waitFor(() => ari.callsTo('POST', '/bridges/cav-m1-br/addChannel').length === 1);
    destroyed(16, 'cav-m1');
    const s = watch(machine);
    await waitFor(() => machine.ended);
    expect(s.at(-1)?.[1]).toBe('machine');
  });

  it('transfers to an agent: the agent leg replaces our media in the bridge', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    await leg.dial();
    await answer(leg);
    const result = leg.transfer({ phone: '+919000000009', last4: '0009' }, 30);
    await waitFor(() => ari.callsTo('POST', `/channels/${ID}-xfer`).length === 1);
    expect(ari.callsTo('POST', `/channels/${ID}-xfer`)[0]?.query).toMatchObject({
      endpoint: 'PJSIP/+919000000009@trunk',
      appArgs: `${CALL},transfer`,
    });
    ari.send({
      type: 'StasisStart',
      channel: { id: `${ID}-xfer`, state: 'Up' },
      args: [CALL, 'transfer'],
    });
    expect(await result).toBe('connected');
    expect(ari.callsTo('POST', `/bridges/${ID}-br/removeChannel`)[0]?.query.channel).toBe(
      `${ID}-em`,
    );
    expect(ari.callsTo('POST', `/bridges/${ID}-br/addChannel`)[1]?.query.channel).toBe(
      `${ID}-xfer`,
    );
    expect(await leg.play(tone(100, 8000))).toEqual({ completed: false, playedMs: 0 });
    expect(await leg.transfer({ phone: '+919000000009', last4: '0009' }, 30)).toBe('failed');
    // the agent hangs up → the call ends
    destroyed(16, `${ID}-xfer`);
    await waitFor(() =>
      ari.calls.some((c) => c.method === 'DELETE' && c.path === `/channels/${ID}`),
    );
    destroyed(16);
    await waitFor(() => leg.ended);
  });

  it('a busy or unanswered agent keeps the bot on the call; bad numbers fail', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    await leg.dial();
    await answer(leg);
    expect(await leg.transfer({ phone: '9876', last4: '9876' }, 30)).toBe('failed');
    const busy = leg.transfer({ phone: '+919000000002', last4: '0002' }, 30);
    await waitFor(() => ari.callsTo('POST', `/channels/${ID}-xfer`).length === 1);
    destroyed(17, `${ID}-xfer`);
    expect(await busy).toBe('no_answer');
    const down = leg.transfer({ phone: '+919000000000', last4: '0000' }, 30);
    await waitFor(() => ari.callsTo('POST', `/channels/${ID}-xfer`).length === 2);
    destroyed(34, `${ID}-xfer`);
    expect(await down).toBe('failed');
    const slow = leg.transfer({ phone: '+919000000003', last4: '0003' }, 0.05);
    expect(await slow).toBe('no_answer');
    ari.on((c) =>
      c.path === `/channels/${ID}-xfer` && c.method === 'POST' ? { status: 500 } : undefined,
    );
    expect(await leg.transfer({ phone: '+919000000003', last4: '0003' }, 30)).toBe('failed');
    expect(leg.ended).toBe(false);
  });

  it('transfer before the answer fails; text and notices do nothing on a phone', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    expect(await leg.transfer({ phone: '+919000000009', last4: '0009' }, 30)).toBe('failed');
    leg.onText(() => undefined);
    leg.notify({ type: 'x' });
    await leg.hangup('normal');
  });

  it('throws when no media port is free; ignores events of unknown channels', async () => {
    const tiny = new SipTelephonyProvider(client, new PortPool(32100, 32100), systemClock, {
      trunk: 'trunk',
      format: 'ulaw',
      ringTimeoutSec: 40,
      mediaTimeoutSec: 10,
      rtpBindHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      asteriskRtpHost: '127.0.0.1',
      defaultCallerId: '+911600000000',
    });
    const one = await tiny.startCall({ callId: 'x1', to: '+919000000001' });
    await expect(tiny.startCall({ callId: 'x2', to: '+919000000001' })).rejects.toBeInstanceOf(
      SipNoMediaPortError,
    );
    ari.send({ type: 'StasisStart', channel: { id: 'PJSIP/trunk-1' }, args: [] });
    ari.send({ type: 'BridgeDestroyed', bridge: { id: 'b' } });
    ari.send({ type: 'Dial', peer: { id: 'cav-x1' }, dialstatus: 'BUSY' });
    destroyed(16, 'cav-x1');
    await waitFor(() => one.ended);
    expect(one.metrics.dialStatus).toBe('BUSY');
    expect(tiny.connected).toBe(true);
  });

  it('after ARI comes back, a leg whose channel is gone ends media_error (T18.13)', async () => {
    const gone = await provider.startCall({ callId: CALL, to: '+919000000001' });
    const kept = await provider.startCall({ callId: 'k1', to: '+919000000001' });
    const sGone = watch(gone);
    await gone.dial();
    await answer(gone);
    await kept.dial();
    ari.on((c) =>
      c.path === '/channels' && c.method === 'GET'
        ? { status: 200, body: [{ id: 'cav-k1' }] }
        : undefined,
    );
    ari.dropSockets();
    await waitFor(() => !client.connected);
    await waitFor(() => client.connected, 5000);
    await waitFor(() => gone.ended);
    expect(sGone.at(-1)).toEqual(['ended', 'media_error']);
    expect(kept.ended).toBe(false);
    await kept.hangup('normal');
    expect(await provider.reconcile()).toBe(0);
  });

  it('a failed channel list after a reconnect ends nothing', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    await leg.dial();
    ari.on((c) => (c.path === '/channels' && c.method === 'GET' ? { status: 500 } : undefined));
    expect(await provider.reconcile()).toBe(0);
    expect(leg.ended).toBe(false);
    await leg.hangup('normal');
  });

  it('hangs up channels of calls no process runs any more (T18.13)', async () => {
    expect(await provider.hangUpOrphans()).toBe(0); // no check set yet
    const mine = await provider.startCall({ callId: CALL, to: '+919000000001' });
    ari.on((c) =>
      c.path === '/channels' && c.method === 'GET'
        ? {
            status: 200,
            body: [
              { id: 'cav-dead1' },
              { id: 'cav-dead1-em' },
              { id: 'cav-alive1' },
              { id: 'PJSIP/trunk-1' },
              { id: ID },
            ],
          }
        : undefined,
    );
    provider.setLiveCheck((id) => Promise.resolve(id === 'alive1'));
    await waitFor(() => ari.callsTo('DELETE', '/channels/cav-dead1').length === 2);
    expect(ari.callsTo('DELETE', '/channels/cav-alive1')).toHaveLength(0);
    expect(ari.callsTo('DELETE', `/channels/${ID}`)).toHaveLength(0);
    ari.on((c) => (c.path === '/channels' && c.method === 'GET' ? { status: 500 } : undefined));
    await mine.hangup('normal');
  });

  it('endAll hangs up every live leg', async () => {
    const leg = await provider.startCall({ callId: CALL, to: '+919000000001' });
    await leg.dial();
    await answer(leg);
    await provider.endAll('media_error');
    expect(ari.callsTo('DELETE', `/channels/${ID}`)[0]?.query).toEqual({ reason: 'congestion' });
    destroyed(16);
    await waitFor(() => leg.ended);
  });
});

const watchAnswered = (leg: SipCallLeg) =>
  !leg.ended &&
  ari.callsTo('POST', '/bridges/').some((c) => c.path.endsWith('addChannel')) &&
  (leg as unknown as { state: string }).state === 'answered';
