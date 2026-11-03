import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AriClient, AriError, type AriEvent } from '../../src/core/telephony/sip/ari-client';

import { FakeAri, waitFor } from './fake-ari';

let ari: FakeAri;
let client: AriClient;

const make = (extra: Partial<ConstructorParameters<typeof AriClient>[0]> = {}) =>
  new AriClient({
    url: ari.url,
    user: 'cav',
    password: 'pw-0123456789abcdefghijkl',
    app: 'cav',
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    ...extra,
  });

beforeEach(async () => {
  ari = await new FakeAri().start();
  client = make();
});

afterEach(async () => {
  client.close();
  await ari.stop();
});

describe('ARI client (T18.3)', () => {
  it('sends basic auth and the app name on every request', async () => {
    await client.info();
    const [call] = ari.calls;
    expect(call?.path).toBe('/asterisk/info');
    expect(call?.auth).toBe(
      `Basic ${Buffer.from('cav:pw-0123456789abcdefghijkl').toString('base64')}`,
    );
  });

  it('originates to the app with caller id, timeout and the call id as channel id', async () => {
    ari.on((c) =>
      c.path.startsWith('/channels/cav-1') ? { status: 200, body: { id: 'cav-1' } } : undefined,
    );
    const ch = await client.originate({
      channelId: 'cav-1',
      endpoint: 'PJSIP/+919000000001@trunk',
      callerId: '+911600000000',
      timeoutSec: 40,
      appArgs: 'call-1',
      variables: { CAV_CALL: 'call-1' },
    });
    expect(ch.id).toBe('cav-1');
    const call = ari.callsTo('POST', '/channels/cav-1')[0]!;
    expect(call.query).toMatchObject({
      endpoint: 'PJSIP/+919000000001@trunk',
      callerId: '+911600000000',
      timeout: '40',
      app: 'cav',
      appArgs: 'call-1',
    });
    expect(call.body).toEqual({ variables: { CAV_CALL: 'call-1' } });
  });

  it('originates into the dialplan for answering machine detection', async () => {
    await client.originate({
      channelId: 'cav-2',
      endpoint: 'PJSIP/+919000000006@trunk',
      callerId: '+911600000000',
      timeoutSec: 40,
      appArgs: 'call-2',
      dialplan: { context: 'cav-amd', extension: 's' },
    });
    const call = ari.callsTo('POST', '/channels/cav-2')[0]!;
    expect(call.query).toMatchObject({ context: 'cav-amd', extension: 's', priority: '1' });
    expect(call.query.app).toBeUndefined();
    expect(call.body).toEqual({ variables: {} });
  });

  it('calls the right paths for media, bridges, hangup and variables', async () => {
    ari.on((c) =>
      c.path === '/channels/cav-3/variable'
        ? { status: 200, body: { value: 'MACHINE' } }
        : undefined,
    );
    await client.answer('cav-3');
    await client.externalMedia({
      channelId: 'cav-3-em',
      externalHost: '127.0.0.1:21000',
      format: 'ulaw',
    });
    await client.createBridge('cav-3-br');
    await client.addToBridge('cav-3-br', ['cav-3', 'cav-3-em']);
    await client.removeFromBridge('cav-3-br', ['cav-3-em']);
    await client.destroyBridge('cav-3-br');
    await client.hangup('cav-3', 'busy');
    expect(await client.getVar('cav-3', 'AMDSTATUS')).toBe('MACHINE');
    await client.listChannels();
    expect(ari.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /channels/cav-3/answer',
      'POST /channels/externalMedia',
      'POST /bridges/cav-3-br',
      'POST /bridges/cav-3-br/addChannel',
      'POST /bridges/cav-3-br/removeChannel',
      'DELETE /bridges/cav-3-br',
      'DELETE /channels/cav-3',
      'GET /channels/cav-3/variable',
      'GET /channels',
    ]);
    expect(ari.calls[1]?.query).toMatchObject({
      channelId: 'cav-3-em',
      app: 'cav',
      external_host: '127.0.0.1:21000',
      format: 'ulaw',
      encapsulation: 'rtp',
      transport: 'udp',
      direction: 'both',
    });
    expect(ari.calls[2]?.query).toEqual({ type: 'mixing' });
    expect(ari.calls[3]?.query).toEqual({ channel: 'cav-3,cav-3-em' });
    expect(ari.calls[6]?.query).toEqual({ reason: 'busy' });
  });

  it('turns failures into AriError with the operation only', async () => {
    ari.on(() => ({ status: 404, body: { message: 'Channel not found' } }));
    const err = await client.answer('gone').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AriError);
    expect(err).toMatchObject({ op: 'answer', status: 404 });
    expect(String(err)).not.toContain('127.0.0.1');
    expect(await client.getVar('gone', 'X')).toBeNull();
  });

  it('times out a request that hangs and reports status 0', async () => {
    const slow = make({ timeoutMs: 30 });
    ari.on(() => new Promise((r) => setTimeout(() => r({ status: 200, body: {} }), 300)));
    await expect(slow.info()).rejects.toMatchObject({ op: 'info', status: 0 });
    slow.close();
  });

  it('a non-404 failure of getVar is thrown', async () => {
    ari.on(() => ({ status: 500 }));
    await expect(client.getVar('cav-4', 'X')).rejects.toMatchObject({ status: 500 });
  });

  it('delivers known events, ignores unknown and broken ones', async () => {
    const seen: AriEvent[] = [];
    client.on('event', (e) => seen.push(e));
    client.connect();
    await waitFor(() => client.connected);
    ari.send({ type: 'PlaybackStarted' });
    ari.send({
      type: 'ChannelDtmfReceived',
      channel: { id: 'cav-5' },
      digit: '5',
      duration_ms: 100,
    });
    for (const ws of (ari as unknown as { sockets: Set<{ send(d: string): void }> }).sockets) {
      ws.send('not json');
    }
    ari.send({ type: 'StasisEnd', channel: { id: 'cav-5' } });
    await waitFor(() => seen.length === 2);
    expect(seen.map((e) => e.type)).toEqual(['ChannelDtmfReceived', 'StasisEnd']);
  });

  it('reconnects after the socket drops and reports state changes', async () => {
    const states: boolean[] = [];
    client.on('state', (s) => states.push(s));
    client.connect();
    await waitFor(() => client.connected);
    ari.refuse = true;
    ari.dropSockets();
    await waitFor(() => !client.connected);
    await new Promise((r) => setTimeout(r, 60));
    expect(client.connected).toBe(false);
    ari.refuse = false;
    await waitFor(() => client.connected, 3000);
    expect(states).toEqual([true, false, true]);
    expect(ari.clients).toBe(1);
  });

  it('stops reconnecting after close()', async () => {
    client.connect();
    await waitFor(() => client.connected);
    client.close();
    await waitFor(() => ari.clients === 0);
    await new Promise((r) => setTimeout(r, 80));
    expect(ari.clients).toBe(0);
    expect(client.connected).toBe(false);
  });
});
