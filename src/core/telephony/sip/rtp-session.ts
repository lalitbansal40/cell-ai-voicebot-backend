import { randomInt } from 'node:crypto';
import { createSocket, type Socket } from 'node:dgram';

import { Framer } from '../../voice/audio/framer';
import { decodeAlaw, decodeMulaw, encodeAlaw, encodeMulaw } from '../../voice/audio/g711';
import type { Pcm16 } from '../../voice/audio/pcm';

import { JitterBuffer, type JitterStats } from './jitter';
import type { PortPool } from './port-pool';
import { buildRtp, parseRtp } from './rtp-packet';

export type G711 = 'ulaw' | 'alaw';

/** RTP payload types (RFC 3551). */
const PAYLOAD_TYPE: Record<G711, number> = { ulaw: 0, alaw: 8 };
/** 20 ms at 8 kHz. */
export const SIP_FRAME_SAMPLES = 160;

export interface RtpStats extends JitterStats {
  packetsIn: number;
  packetsOut: number;
  /** Packets from a second source or with another payload type (ignored). */
  ignored: number;
  lossPct: number;
}

export interface RtpSessionOptions {
  format: G711;
  bindHost: string;
  now?: () => number;
}

/**
 * Our end of one call's ExternalMedia stream: G.711 RTP over UDP on loopback ↔ PCM16
 * frames of 20 ms. The first source we hear is locked in (strict RTP); others are ignored.
 */
export class RtpSession {
  private readonly jitter = new JitterBuffer();
  private readonly framer = new Framer(SIP_FRAME_SAMPLES);
  private readonly frameFns: ((frame: Pcm16) => void)[] = [];
  private peer: { host: string; port: number } | null = null;
  private ssrcIn: number | null = null;
  private readonly ssrcOut = randomInt(0, 2 ** 32 - 1);
  private seq = randomInt(0, 0xffff);
  private ts = randomInt(0, 2 ** 31);
  private markNext = true;
  private packetsIn = 0;
  private packetsOut = 0;
  private ignored = 0;
  private lastAt: number | null = null;
  private closed = false;
  private readonly now: () => number;

  private constructor(
    private readonly socket: Socket,
    readonly port: number,
    private readonly options: RtpSessionOptions,
    private readonly onClose: () => void,
  ) {
    this.now = options.now ?? Date.now;
    socket.on('message', (msg) => this.receive(msg));
  }

  /** Leases a port and binds it; tries the next port when one is taken by another process. */
  static async open(
    pool: PortPool,
    callId: string,
    options: RtpSessionOptions,
  ): Promise<RtpSession | null> {
    const tried = new Set<number>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const port = pool.lease(callId, tried);
      if (port === null) return null;
      tried.add(port);
      const socket = createSocket('udp4');
      const bound = await new Promise<boolean>((resolve) => {
        socket.once('error', () => resolve(false));
        socket.bind(port, options.bindHost, () => resolve(true));
      });
      if (bound) {
        socket.on('error', () => {
          // a send to a closed peer port; the media timeout ends the call if it lasts
        });
        return new RtpSession(socket, port, options, () => pool.release(port));
      }
      socket.close();
      pool.release(port);
    }
    return null;
  }

  /** Where our audio goes (Asterisk's ExternalMedia address). */
  setPeer(host: string, port: number): void {
    this.peer = { host, port };
  }

  onFrame(fn: (frame: Pcm16) => void): void {
    this.frameFns.push(fn);
  }

  /** Time of the last accepted packet (media timeout), or null before the first. */
  get lastPacketAt(): number | null {
    return this.lastAt;
  }

  /** The next packet starts a talk spurt (after barge-in / silence). */
  markTalkStart(): void {
    this.markNext = true;
  }

  send(frame: Pcm16): void {
    if (this.closed || !this.peer) return;
    const payload = this.options.format === 'ulaw' ? encodeMulaw(frame) : encodeAlaw(frame);
    const packet = buildRtp({
      payloadType: PAYLOAD_TYPE[this.options.format],
      marker: this.markNext,
      seq: this.seq,
      timestamp: this.ts,
      ssrc: this.ssrcOut,
      payload,
    });
    this.markNext = false;
    this.seq = (this.seq + 1) & 0xffff;
    this.ts = (this.ts + frame.length) >>> 0;
    this.packetsOut += 1;
    this.socket.send(packet, this.peer.port, this.peer.host);
  }

  private receive(msg: Buffer): void {
    if (this.closed) return;
    const packet = parseRtp(msg);
    if (!packet || packet.payloadType !== PAYLOAD_TYPE[this.options.format]) {
      this.ignored += 1;
      return;
    }
    if (this.ssrcIn === null) this.ssrcIn = packet.ssrc;
    if (packet.ssrc !== this.ssrcIn) {
      this.ignored += 1;
      return;
    }
    this.packetsIn += 1;
    this.lastAt = this.now();
    for (const payload of this.jitter.push(
      packet.seq,
      packet.timestamp,
      packet.payload,
      this.lastAt,
    )) {
      const pcm = this.options.format === 'ulaw' ? decodeMulaw(payload) : decodeAlaw(payload);
      for (const frame of this.framer.push(pcm)) {
        for (const fn of this.frameFns) fn(frame);
      }
    }
  }

  get stats(): RtpStats {
    const j = this.jitter.snapshot;
    const expected = j.received + j.lost;
    return {
      ...j,
      packetsIn: this.packetsIn,
      packetsOut: this.packetsOut,
      ignored: this.ignored,
      lossPct: expected === 0 ? 0 : Math.round((j.lost / expected) * 1000) / 10,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.frameFns.length = 0;
    this.socket.close();
    this.onClose();
  }
}
