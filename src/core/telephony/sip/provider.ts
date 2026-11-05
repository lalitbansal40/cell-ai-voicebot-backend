import type { Clock } from '../../voice/clock';
import type { StartCallRequest, TelephonyProvider } from '../types';

import type { AriChannel, AriClient, AriEvent } from './ari-client';
import type { SipCapacity } from './capacity';
import { SipCallLeg, type InboundReject, type SipLegOptions } from './leg';
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

/** Every trunk channel is in use, or no calls-per-second slot came in time. */
export class SipLineBusyError extends Error {
  constructor() {
    super('sip: line busy');
    this.name = 'SipLineBusyError';
  }
}

/** A trunk call that reached our inbound app (Phase 20): who called which number. */
export interface IncomingSipCall {
  /** Asterisk's channel id (not ours: the trunk created it). */
  channelId: string;
  /** Digits as the dialplan passed them (`CAV_DID`); normalised by the caller. */
  did: string;
  /** Caller number as the trunk sent it (may be empty / `anonymous`). */
  caller: string;
}

export type IncomingSipHandler = (call: IncomingSipCall) => void | Promise<void>;

/** Channels in the inbound app with no call this long are hung up as orphans. */
const INBOUND_ORPHAN_MS = 60_000;

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
  get ringTimeoutSec(): number {
    return this.config.ringTimeoutSec;
  }
  private readonly legs = new Map<string, SipCallLeg>();
  /** Channel leases of this process (call ids and `<callId>:xfer`). */
  private readonly leases = new Set<string>();
  private refreshTimer: unknown = null;
  /** Phase 20: Asterisk channel id of an incoming call → our call id. */
  private readonly inboundChannels = new Map<string, string>();
  /** Incoming channels not taken yet (StasisStart seen, no leg): id → first seen. */
  private readonly pendingInbound = new Map<string, number>();
  private incomingHandler: IncomingSipHandler | null = null;

  constructor(
    private readonly ari: AriClient,
    private readonly pool: PortPool,
    private readonly clock: Clock,
    private readonly config: SipLineConfig,
    /** Trunk limits shared in Redis (T18.8); absent in unit tests of the line itself. */
    private readonly capacity?: SipCapacity,
  ) {
    ari.on('event', (event) => this.route(event));
    let wasUp = ari.connected;
    ari.on('state', (up) => {
      if (up && wasUp) void this.reconcile();
      if (up) void this.hangUpOrphans();
      if (up) wasUp = true;
    });
  }

  private isLive: ((callId: string) => Promise<boolean>) | null = null;

  /**
   * How to tell a channel of a call that no process runs any more (the call registry).
   * Set once the call manager exists; orphans are checked on every ARI connect.
   */
  setLiveCheck(fn: (callId: string) => Promise<boolean>): void {
    this.isLive = fn;
    if (this.ari.connected) void this.hangUpOrphans();
  }

  /** Channels of calls whose process died (customer would hear silence): hung up. */
  async hangUpOrphans(): Promise<number> {
    const check = this.isLive;
    if (!check) return 0;
    let channels: { id: string }[];
    try {
      channels = await this.ari.listChannels();
    } catch {
      return 0;
    }
    let ended = 0;
    for (const { id } of channels) {
      // Phase 20: incoming channels — ours while a leg has them, else after a minute
      if (this.inboundChannels.has(id)) continue;
      const seen = this.pendingInbound.get(id);
      if (seen !== undefined) {
        if (this.clock.now() - seen > INBOUND_ORPHAN_MS) {
          this.pendingInbound.delete(id);
          ended += 1;
          await this.ari.hangup(id).catch(() => undefined);
        }
        continue;
      }
      const owner = await this.ari.getVar(id, 'CAV_CALL_ID').catch(() => null);
      const callId = callIdOfChannel(id) ?? (owner && /^[a-f0-9]{24}$/.test(owner) ? owner : null);
      if (!callId || this.legs.has(callId)) continue;
      if (await check(callId).catch(() => true)) continue;
      ended += 1;
      await this.ari.hangup(id).catch(() => undefined);
    }
    return ended;
  }

  /**
   * After the event socket came back (Asterisk restart, network blip, T18.13): a leg
   * whose channel is gone missed its ChannelDestroyed — it ends as `media_error`.
   */
  async reconcile(): Promise<number> {
    if (this.legs.size === 0) return 0;
    let alive: Set<string>;
    try {
      alive = new Set((await this.ari.listChannels()).map((c) => c.id));
    } catch {
      return 0; // the media timeout ends them if Asterisk stays away
    }
    let ended = 0;
    for (const leg of [...this.legs.values()]) {
      if (!alive.has(leg.ids.main)) {
        ended += 1;
        leg.lost();
      }
    }
    return ended;
  }

  private async lease(id: string, kind: 'outbound' | 'inbound' = 'outbound'): Promise<boolean> {
    if (!this.capacity) return true;
    if (!(await this.capacity.acquire(id, kind))) return false;
    this.leases.add(id);
    if (this.refreshTimer === null) {
      this.refreshTimer = this.clock.setInterval(() => {
        void this.capacity?.refresh([...this.leases]).catch(() => undefined);
      }, this.capacity.refreshEveryMs);
    }
    return true;
  }

  private unlease(id: string): void {
    if (!this.leases.delete(id)) return;
    void this.capacity?.release(id).catch(() => undefined);
    if (this.leases.size === 0 && this.refreshTimer !== null) {
      this.clock.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
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
    if (!(await this.lease(request.callId))) throw new SipLineBusyError();
    if (this.capacity && !(await this.capacity.dialToken())) {
      this.unlease(request.callId);
      throw new SipLineBusyError();
    }
    const rtp = await RtpSession.open(this.pool, request.callId, {
      format: this.config.format,
      bindHost: this.config.rtpBindHost,
      now: () => this.clock.now(),
    });
    if (!rtp) {
      this.unlease(request.callId);
      throw new SipNoMediaPortError();
    }
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
      channels: {
        acquire: (id) => this.lease(id),
        release: (id) => this.unlease(id),
      },
    };
    const leg = new SipCallLeg(this.ari, rtp, this.clock, options);
    this.legs.set(request.callId, leg);
    leg.onEnded(() => {
      this.legs.delete(request.callId);
      this.unlease(request.callId);
      this.unlease(`${request.callId}:xfer`);
    });
    return leg;
  }

  /** Phase 20: who takes trunk calls that reach the inbound app (one handler per process). */
  onIncoming(handler: IncomingSipHandler): void {
    this.incomingHandler = handler;
  }

  /**
   * Takes an incoming call (Phase 20): a trunk channel (any free channel; no calls-per-second
   * slot) and an RTP port; the leg rings until `dial()` answers it.
   * Throws `SipLineBusyError` / `SipNoMediaPortError` like `startCall`.
   */
  async acceptInbound(input: {
    callId: string;
    channelId: string;
    did: string;
  }): Promise<SipCallLeg> {
    this.pendingInbound.delete(input.channelId);
    if (!(await this.lease(input.callId, 'inbound'))) throw new SipLineBusyError();
    const rtp = await RtpSession.open(this.pool, input.callId, {
      format: this.config.format,
      bindHost: this.config.rtpBindHost,
      now: () => this.clock.now(),
    });
    if (!rtp) {
      this.unlease(input.callId);
      throw new SipNoMediaPortError();
    }
    const leg = new SipCallLeg(this.ari, rtp, this.clock, {
      callId: input.callId,
      to: input.did,
      // a transfer from this call shows the dialed number (the account's own)
      callerId: input.did,
      trunk: this.config.trunk,
      format: this.config.format,
      ringTimeoutSec: this.config.ringTimeoutSec,
      mediaTimeoutSec: this.config.mediaTimeoutSec,
      advertiseHost: this.config.advertiseHost,
      asteriskRtpHost: this.config.asteriskRtpHost,
      amd: false,
      hangupOnMachine: false,
      app: this.config.app ?? 'cav',
      channels: {
        acquire: (id) => this.lease(id),
        release: (id) => this.unlease(id),
      },
      inbound: { channelId: input.channelId },
    });
    this.legs.set(input.callId, leg);
    this.inboundChannels.set(input.channelId, input.callId);
    leg.onEnded(() => {
      this.legs.delete(input.callId);
      this.inboundChannels.delete(input.channelId);
      this.unlease(input.callId);
      this.unlease(`${input.callId}:xfer`);
    });
    return leg;
  }

  /** Refuses an incoming channel no leg was made for (unknown number, line full…). */
  async rejectInbound(channelId: string, reason: InboundReject): Promise<void> {
    this.pendingInbound.delete(channelId);
    const raw = reason === 'busy' ? 'busy' : reason === 'unavailable' ? 'congestion' : 'rejected';
    await this.ari.hangup(channelId, raw).catch(() => undefined);
  }

  private incoming(channel: AriChannel, args: string[]): void {
    if (this.pendingInbound.has(channel.id)) return;
    this.pendingInbound.set(channel.id, this.clock.now());
    const handler = this.incomingHandler;
    if (!handler) {
      void this.rejectInbound(channel.id, 'unavailable');
      return;
    }
    const call: IncomingSipCall = {
      channelId: channel.id,
      did: args[0] ?? '',
      caller: args[1] ?? channel.caller?.number ?? '',
    };
    void Promise.resolve()
      .then(() => handler(call))
      .catch(() => this.rejectInbound(channel.id, 'unavailable'));
  }

  private route(event: AriEvent): void {
    const id =
      event.type === 'Dial'
        ? event.peer.id
        : event.type === 'BridgeDestroyed'
          ? null
          : (event.channel?.id ?? null);
    if (!id) return;
    const inboundCall = this.inboundChannels.get(id);
    if (inboundCall) {
      this.legs.get(inboundCall)?.handle(event);
      return;
    }
    const callId = callIdOfChannel(id);
    if (!callId) {
      // Phase 20: a trunk channel entering the inbound app (args = did, caller)
      if (event.type === 'StasisStart' && !id.startsWith('cav-'))
        this.incoming(event.channel, event.args);
      else if (event.type === 'ChannelDestroyed') this.pendingInbound.delete(id);
      return;
    }
    this.legs.get(callId)?.handle(event);
  }

  /** Every leg ended `media_error` (Asterisk restarted, T18.13 decides when). */
  async endAll(cause: 'media_error' | 'server_shutdown'): Promise<void> {
    await Promise.all([...this.legs.values()].map((leg) => leg.hangup(cause)));
  }
}
