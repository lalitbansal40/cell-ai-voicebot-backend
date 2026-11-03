import { createSocket, type Socket } from 'node:dgram';

import { afterEach, describe, expect, it } from 'vitest';

import { JitterBuffer } from '../../src/core/telephony/sip/jitter';
import { parsePortRange, PortPool } from '../../src/core/telephony/sip/port-pool';
import { buildRtp, parseRtp, seqDiff } from '../../src/core/telephony/sip/rtp-packet';
import { RtpSession, SIP_FRAME_SAMPLES } from '../../src/core/telephony/sip/rtp-session';
import { encodeAlaw, encodeMulaw } from '../../src/core/voice/audio/g711';
import { rms, tone } from '../../src/core/voice/audio/pcm';

import { waitFor } from './fake-ari';

const bytes = (n: number, fill = 0xff) => new Uint8Array(n).fill(fill);

describe('RTP packets (T18.4)', () => {
  it('builds and parses the fixed header', () => {
    const buf = buildRtp({
      payloadType: 0,
      marker: true,
      seq: 65535,
      timestamp: 2 ** 32 - 1,
      ssrc: 0xdeadbeef,
      payload: bytes(160, 7),
    });
    expect(buf.length).toBe(172);
    const p = parseRtp(buf)!;
    expect(p).toMatchObject({
      payloadType: 0,
      marker: true,
      seq: 65535,
      timestamp: 2 ** 32 - 1,
      ssrc: 0xdeadbeef,
    });
    expect(p.payload.length).toBe(160);
    expect(p.payload[0]).toBe(7);
  });

  it('skips CSRCs, extensions and padding; refuses junk', () => {
    const base = buildRtp({
      payloadType: 8,
      marker: false,
      seq: 1,
      timestamp: 1,
      ssrc: 1,
      payload: bytes(8, 1),
    });
    // one CSRC + a 1-word extension + 2 bytes of padding
    const csrc = Buffer.alloc(4, 9);
    const ext = Buffer.from([0xbe, 0xde, 0x00, 0x01, 0, 0, 0, 0]);
    const pad = Buffer.from([0, 2]);
    const head = Buffer.from(base.subarray(0, 12));
    head[0] = 0x80 | 0x20 | 0x10 | 0x01;
    const p = parseRtp(Buffer.concat([head, csrc, ext, base.subarray(12), pad]))!;
    expect(Uint8Array.from(p.payload)).toEqual(new Uint8Array(8).fill(1));
    expect(parseRtp(Buffer.alloc(12))).toBeNull();
    expect(parseRtp(Buffer.from([0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))).toBeNull();
    const shortExt = Buffer.from(head);
    shortExt[0] = 0x90;
    expect(parseRtp(Buffer.concat([shortExt, Buffer.from([1, 2])]))).toBeNull();
    const allPad = Buffer.from(base);
    allPad[0] = 0xa0;
    allPad[allPad.length - 1] = 9;
    expect(parseRtp(allPad)).toBeNull();
  });

  it('measures sequence distance across the wrap', () => {
    expect(seqDiff(0, 65535)).toBe(1);
    expect(seqDiff(65535, 0)).toBe(-1);
    expect(seqDiff(10, 5)).toBe(5);
  });
});

describe('jitter buffer (T18.4)', () => {
  const p = (n: number) => new Uint8Array([n]);

  it('passes in-order packets at once and reorders a swap', () => {
    const j = new JitterBuffer();
    expect(j.push(1, 160, p(1), 0)).toEqual([p(1)]);
    expect(j.push(3, 480, p(3), 40)).toEqual([]);
    expect(j.push(2, 320, p(2), 41)).toEqual([p(2), p(3)]);
    expect(j.snapshot).toMatchObject({ received: 3, lost: 0, late: 0 });
  });

  it('conceals a lost packet with the last frame after waiting 3 frames', () => {
    const j = new JitterBuffer(3);
    j.push(10, 0, p(10), 0);
    expect(j.push(12, 320, p(12), 40)).toEqual([]);
    expect(j.push(13, 480, p(13), 60)).toEqual([]);
    expect(j.push(14, 640, p(14), 80)).toEqual([]);
    expect(j.push(15, 800, p(15), 100)).toEqual([p(10), p(12), p(13), p(14), p(15)]);
    expect(j.snapshot.lost).toBe(1);
  });

  it('drops late and duplicate packets, and wraps the sequence', () => {
    const j = new JitterBuffer();
    j.push(65535, 0, p(1), 0);
    expect(j.push(0, 160, p(2), 20)).toEqual([p(2)]);
    expect(j.push(65535, 0, p(1), 30)).toEqual([]);
    j.push(2, 480, p(4), 60);
    expect(j.push(2, 480, p(4), 61)).toEqual([]);
    expect(j.snapshot).toMatchObject({ late: 1, duplicates: 1 });
  });

  it('computes RFC 3550 jitter from arrival spread', () => {
    const steady = new JitterBuffer();
    for (let i = 0; i < 20; i += 1) steady.push(i, i * 160, p(i), i * 20);
    expect(steady.snapshot.jitterMs).toBe(0);
    const bumpy = new JitterBuffer();
    for (let i = 0; i < 20; i += 1) bumpy.push(i, i * 160, p(i), i * 20 + (i % 2) * 10);
    expect(bumpy.snapshot.jitterMs).toBeGreaterThan(3);
  });
});

describe('port pool (T18.4)', () => {
  it('leases round robin, skips taken ports and runs out', () => {
    const pool = new PortPool(30000, 30002);
    expect(pool.size).toBe(3);
    expect(pool.lease('a')).toBe(30000);
    expect(pool.lease('b', new Set([30001]))).toBe(30002);
    expect(pool.lease('c')).toBe(30001);
    expect(pool.lease('d')).toBeNull();
    pool.release(30000);
    expect(pool.leased).toBe(2);
    expect(pool.lease('e')).toBe(30000);
  });

  it('sweeps leases of calls that ended', () => {
    const pool = new PortPool(30000, 30009);
    pool.lease('live');
    pool.lease('gone');
    expect(pool.sweep((id) => id === 'live')).toBe(1);
    expect(pool.leased).toBe(1);
  });

  it('validates ranges', () => {
    expect(parsePortRange('21000-21999')).toEqual({ min: 21000, max: 21999 });
    expect(() => parsePortRange('21000')).toThrow(RangeError);
    expect(() => new PortPool(100, 200)).toThrow(RangeError);
    expect(() => new PortPool(3000, 2000)).toThrow(RangeError);
  });
});

describe('RTP session over loopback (T18.4)', () => {
  const open: (RtpSession | Socket)[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.close();
  });

  const peer = async () => {
    const sock = createSocket('udp4');
    await new Promise<void>((r) => sock.bind(0, '127.0.0.1', r));
    open.push(sock);
    const got: Buffer[] = [];
    sock.on('message', (m) => got.push(m));
    return { sock, port: sock.address().port, got };
  };

  const session = async (pool = new PortPool(31000, 31099), format: 'ulaw' | 'alaw' = 'ulaw') => {
    const s = (await RtpSession.open(pool, 'call-1', { format, bindHost: '127.0.0.1' }))!;
    open.push(s);
    return s;
  };

  it('sends PCM16 frames as G.711 RTP with our own sequence, timestamp and marker', async () => {
    const far = await peer();
    const s = await session();
    s.setPeer('127.0.0.1', far.port);
    const frame = tone(20, 8000);
    s.send(frame);
    s.send(frame);
    s.markTalkStart();
    s.send(frame);
    await waitFor(() => far.got.length === 3);
    const [a, b, c] = far.got.map((m) => parseRtp(m)!);
    expect(a!.payloadType).toBe(0);
    expect(a!.marker).toBe(true);
    expect(b!.marker).toBe(false);
    expect(c!.marker).toBe(true);
    expect(seqDiff(b!.seq, a!.seq)).toBe(1);
    expect(b!.timestamp - a!.timestamp).toBe(SIP_FRAME_SAMPLES);
    expect(Buffer.from(a!.payload)).toEqual(Buffer.from(encodeMulaw(frame)));
    expect(s.stats.packetsOut).toBe(3);
  });

  it('does nothing before the peer is known or after close', async () => {
    const s = await session();
    s.send(new Int16Array(SIP_FRAME_SAMPLES));
    expect(s.stats.packetsOut).toBe(0);
    s.close();
    s.close();
    s.setPeer('127.0.0.1', 9);
    s.send(new Int16Array(SIP_FRAME_SAMPLES));
    expect(s.stats.packetsOut).toBe(0);
  });

  it('decodes incoming A-law into 20 ms frames, locks the first source and ignores others', async () => {
    const s = await session(new PortPool(31100, 31199), 'alaw');
    const frames: Int16Array[] = [];
    s.onFrame((f) => frames.push(f));
    const far = await peer();
    const other = await peer();
    const pcm = tone(20, 8000);
    const send = (sock: Socket, seq: number, ssrc: number, pt = 8, n = 160) =>
      sock.send(
        buildRtp({
          payloadType: pt,
          marker: false,
          seq,
          timestamp: seq * 160,
          ssrc,
          payload: encodeAlaw(pcm).subarray(0, n),
        }),
        s.port,
        '127.0.0.1',
      );
    send(far.sock, 1, 111);
    send(far.sock, 2, 111);
    send(other.sock, 3, 222);
    send(far.sock, 3, 111, 0);
    far.sock.send(Buffer.from('junk'), s.port, '127.0.0.1');
    // two half frames make one frame
    send(far.sock, 3, 111, 8, 80);
    send(far.sock, 4, 111, 8, 80);
    await waitFor(() => s.stats.ignored === 3 && frames.length === 3);
    expect(frames.every((f) => f.length === SIP_FRAME_SAMPLES)).toBe(true);
    expect(rms(frames[0]!)).toBeGreaterThan(1000);
    expect(s.lastPacketAt).not.toBeNull();
    expect(s.stats).toMatchObject({ packetsIn: 4, ignored: 3, lossPct: 0 });
  });

  it('tries the next port when one is taken and gives up when the pool is empty', async () => {
    const blocker = createSocket('udp4');
    await new Promise<void>((r) => blocker.bind(31200, '127.0.0.1', r));
    open.push(blocker);
    const pool = new PortPool(31200, 31201);
    const s = (await RtpSession.open(pool, 'c', { format: 'ulaw', bindHost: '127.0.0.1' }))!;
    open.push(s);
    expect(s.port).toBe(31201);
    expect(pool.leased).toBe(1);
    expect(await RtpSession.open(pool, 'd', { format: 'ulaw', bindHost: '127.0.0.1' })).toBeNull();
    s.close();
    expect(pool.leased).toBe(0);
  });
});
