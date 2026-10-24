import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
  type RTCIceServer,
  type RTCRtpTransceiver,
} from 'werift';

import { withPtime } from './sdp';

/** The parts of werift's sender used to send non-primary payload types (DTMF). */
interface SenderInternals {
  ssrc: number;
  seqOffset: number;
  timestampOffset: number;
  dtlsTransport?: { sendRtp(payload: Buffer, header: RtpHeader): Promise<number> };
}

/**
 * One WebRTC session with Meta for a WhatsApp call (plan §1h, ADR 0040).
 * Meta is ICE-lite; we run full ICE and take the controlling role, so no TURN
 * is needed. Audio is Opus 48 kHz in 20 ms packets on one SSRC; DTMF uses RFC
 * 4733 `telephone-event/8000`. SDP and ICE data never leave this object for logs.
 */
export const OPUS_PT = 111;
export const DTMF_PT = 126;

export const whatsappAudioCodecs = (): RTCRtpCodecParameters[] => [
  new RTCRtpCodecParameters({
    mimeType: 'audio/opus',
    clockRate: 48_000,
    channels: 2,
    payloadType: OPUS_PT,
    parameters: 'minptime=10;useinbandfec=1',
  }),
  new RTCRtpCodecParameters({
    mimeType: 'audio/telephone-event',
    clockRate: 8_000,
    payloadType: DTMF_PT,
  }),
];

export interface PeerOptions {
  /** `meta` = the fake WhatsApp side (dev / tests): ICE-lite like Meta's relay. */
  role: 'business' | 'meta';
  /** Bind address for UDP (tests: `127.0.0.1`). */
  bindAddress?: string;
  /** Extra host candidate (the server's public IP behind 1:1 NAT). */
  publicIp?: string | null;
  portRange?: [number, number];
  stunUrls?: string[];
}

export type PeerState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface ReceivedPacket {
  payloadType: number;
  payload: Buffer;
  timestamp: number;
  marker: boolean;
  sequenceNumber: number;
}

const randomU32 = (): number => Math.floor(Math.random() * 0xffff_ffff) >>> 0;

export class WhatsAppPeer {
  readonly pc: RTCPeerConnection;
  private readonly track = new MediaStreamTrack({ kind: 'audio' });
  private readonly transceiver: RTCRtpTransceiver;
  private readonly ssrc = randomU32();
  private seq = Math.floor(Math.random() * 0xffff);
  private ts = randomU32();
  private packetFns: ((p: ReceivedPacket) => void)[] = [];
  private stateFns: ((s: PeerState) => void)[] = [];
  private connectedResolve: (() => void) | null = null;
  readonly connected: Promise<void>;
  private closed = false;

  constructor(options: PeerOptions) {
    const iceServers: RTCIceServer[] = (options.stunUrls ?? []).map((urls) => ({ urls }));
    const loopback = options.bindAddress === '127.0.0.1';
    this.pc = new RTCPeerConnection({
      codecs: { audio: whatsappAudioCodecs() },
      iceLite: options.role === 'meta',
      iceServers,
      iceUseIpv6: false,
      iceUseTcp: false,
      iceTcpPassive: false,
      // werift waits this long for STUN answers while gathering; none configured → don't wait
      iceStunGatherTimeout: iceServers.length ? 2 : 0,
      ...(options.bindAddress ? { iceInterfaceAddresses: { udp4: options.bindAddress } } : {}),
      ...(loopback || options.publicIp
        ? { iceAdditionalHostAddresses: [loopback ? '127.0.0.1' : (options.publicIp ?? '')] }
        : {}),
      ...(options.portRange ? { icePortRange: options.portRange } : {}),
      bundlePolicy: 'max-bundle',
    });
    this.transceiver = this.pc.addTransceiver(this.track, { direction: 'sendrecv' });
    this.connected = new Promise((resolve) => {
      this.connectedResolve = resolve;
    });
    this.pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') this.connectedResolve?.();
      for (const fn of this.stateFns) fn(state);
    });
    this.pc.onTrack.subscribe((remote) => {
      remote.onReceiveRtp.subscribe((rtp) => {
        const p: ReceivedPacket = {
          payloadType: rtp.header.payloadType,
          payload: rtp.payload,
          timestamp: rtp.header.timestamp,
          marker: rtp.header.marker,
          sequenceNumber: rtp.header.sequenceNumber,
        };
        for (const fn of this.packetFns) fn(p);
      });
    });
  }

  onPacket(fn: (p: ReceivedPacket) => void): void {
    this.packetFns.push(fn);
  }

  onState(fn: (s: PeerState) => void): void {
    this.stateFns.push(fn);
  }

  private async gathered(): Promise<string> {
    if (this.pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const sub = this.pc.iceGatheringStateChange.subscribe((state) => {
          if (state === 'complete') {
            sub.unSubscribe();
            resolve();
          }
        });
      });
    }
    return withPtime(this.pc.localDescription?.sdp ?? '');
  }

  /** Business-initiated calls: our offer (ICE gathered, no trickle). */
  async createOffer(): Promise<string> {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    return this.gathered();
  }

  /** Apply the remote offer and return our answer (user-initiated calls / the fake). */
  async answer(offerSdp: string): Promise<string> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    return this.gathered();
  }

  /** Business-initiated calls: Meta's answer from the `connect` webhook. */
  async applyAnswer(answerSdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /**
   * Sends one RTP packet. `samples` advances the RTP clock (Opus: 960 per 20 ms
   * at 48 kHz; DTMF keeps the event's start timestamp, so pass 0).
   */
  sendPacket(
    payloadType: number,
    payload: Buffer,
    options: { samples: number; marker?: boolean; timestamp?: number },
  ): number {
    if (this.closed) return this.ts;
    const timestamp = options.timestamp ?? this.ts;
    const header = new RtpHeader({
      payloadType,
      sequenceNumber: this.seq,
      timestamp,
      ssrc: this.ssrc,
      marker: options.marker ?? false,
    });
    this.seq = (this.seq + 1) & 0xffff;
    if (options.timestamp === undefined) this.ts = (this.ts + options.samples) >>> 0;
    if (payloadType === OPUS_PT) {
      this.track.writeRtp(new RtpPacket(header, payload));
      return timestamp;
    }
    // werift's sender rewrites every packet to the primary codec's payload type,
    // so RFC 4733 events go straight to the transport on the same SSRC / sequence
    const sender = this.transceiver.sender as unknown as SenderInternals;
    if (sender.dtlsTransport) {
      header.ssrc = sender.ssrc;
      header.sequenceNumber = (header.sequenceNumber + sender.seqOffset) & 0xffff;
      header.timestamp = (header.timestamp + sender.timestampOffset) >>> 0;
      void sender.dtlsTransport.sendRtp(payload, header).catch(() => undefined);
    }
    return timestamp;
  }

  /** Current RTP timestamp (the start of the next audio packet). */
  get rtpTimestamp(): number {
    return this.ts;
  }

  advance(samples: number): void {
    this.ts = (this.ts + samples) >>> 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.track.stop();
    await this.pc.close();
  }
}
