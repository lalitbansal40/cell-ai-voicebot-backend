import type { Clock } from '../../voice/clock';
import type { StartCallRequest, TelephonyProvider } from '../types';

import type { AriClient, AriEvent } from './ari-client';
import { SipCallLeg, type SipLegOptions } from './leg';
import type { PortPool } from './port-pool';
import { RtpSession, type G711 } from './rtp-session';

export interface SipLineConfig {
  trunk: string;
  format: G711;
  ringTimeoutSec: number;
  mediaTimeoutSec: number;
  rtpBindHost: string;
  advertiseHost: string;
  asteriskRtpHost: string;
  defaultCallerId: string;
  /** ARI app of this process; the AMD dialplan hands the call back to it. */
  app?: string;
}

export interface SipCallRequest extends StartCallRequest {
  callerId?: string | null;
  amd?: 'off' | 'hangup' | 'leave_message';
}

/** No local RTP port could be bound (the pool is full or every try was taken). */
export class SipNoMediaPortError extends Error {
  constructor() {
    super('sip: no media port free');
    this.name = 'SipNoMediaPortError';
  }
}

/** `cav-<callId>`, `cav-<callId>-em`, `cav-<callId>-xfer` → `<callId>`. */
export const callIdOfChannel = (channelId: string): string | null => {
  const m = /^cav-([^-]+)(?:-(?:em|xfer))?$/.exec(channelId);
  return m ? (m[1] as string) : null;
};

/**
 * The SIP line (ADR 0020 / 0050): one ARI connection owned by this process; every
 * event is routed to the leg of its call. `startCall` prepares the leg (RTP port
 * bound); the caller dials with `leg.dial()` once its session listens.
 */
export class SipTelephonyProvider implements TelephonyProvider {
  readonly name = 'sip' as const;
  private readonly legs = new Map<string, SipCallLeg>();

  constructor(
    private readonly ari: AriClient,
    private readonly pool: PortPool,
    private readonly clock: Clock,
    private readonly config: SipLineConfig,
  ) {
    ari.on('event', (event) => this.route(event));
  }

  get connected(): boolean {
    return this.ari.connected;
  }

  /** Calls with a leg on this process. */
  get live(): number {
    return this.legs.size;
  }

  has(callId: string): boolean {
    return this.legs.has(callId);
  }

  async startCall(request: SipCallRequest): Promise<SipCallLeg> {
    const rtp = await RtpSession.open(this.pool, request.callId, {
      format: this.config.format,
      bindHost: this.config.rtpBindHost,
      now: () => this.clock.now(),
    });
    if (!rtp) throw new SipNoMediaPortError();
    const options: SipLegOptions = {
      callId: request.callId,
      to: request.to,
      callerId: request.callerId ?? this.config.defaultCallerId,
      trunk: this.config.trunk,
      format: this.config.format,
      ringTimeoutSec: this.config.ringTimeoutSec,
      mediaTimeoutSec: this.config.mediaTimeoutSec,
      advertiseHost: this.config.advertiseHost,
      asteriskRtpHost: this.config.asteriskRtpHost,
      amd: request.amd !== undefined && request.amd !== 'off',
      hangupOnMachine: request.amd === 'hangup',
      app: this.config.app ?? 'cav',
    };
    const leg = new SipCallLeg(this.ari, rtp, this.clock, options);
    this.legs.set(request.callId, leg);
    leg.onEnded(() => this.legs.delete(request.callId));
    return leg;
  }

  private route(event: AriEvent): void {
    const id =
      event.type === 'Dial'
        ? event.peer.id
        : event.type === 'BridgeDestroyed'
          ? null
          : (event.channel?.id ?? null);
    if (!id) return;
    const callId = callIdOfChannel(id);
    if (!callId) return;
    this.legs.get(callId)?.handle(event);
  }

  /** Every leg ended `media_error` (Asterisk restarted, T18.13 decides when). */
  async endAll(cause: 'media_error' | 'server_shutdown'): Promise<void> {
    await Promise.all([...this.legs.values()].map((leg) => leg.hangup(cause)));
  }
}
