import { WebSocket, type RawData } from 'ws';

import { TypedEmitter } from '../../voice/providers/emitter';

/**
 * Asterisk REST Interface client (ADR 0050): REST over fetch with basic auth and a
 * timeout per request, events over one WebSocket that reconnects with backoff.
 * Only the events and calls the SIP line uses are typed; others are ignored.
 */

export interface AriConfig {
  /** e.g. `http://127.0.0.1:8088` (no path, no credentials). */
  url: string;
  user: string;
  password: string;
  app: string;
  timeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
}

export interface AriChannel {
  id: string;
  name: string;
  state: string;
  caller?: { number: string };
  connected?: { number: string };
  channelvars?: Record<string, string>;
}

export type AriEvent =
  | { type: 'StasisStart'; channel: AriChannel; args: string[] }
  | { type: 'StasisEnd'; channel: AriChannel }
  | { type: 'ChannelStateChange'; channel: AriChannel }
  | { type: 'ChannelDestroyed'; channel: AriChannel; cause: number; cause_txt: string }
  | { type: 'ChannelHangupRequest'; channel: AriChannel; cause?: number }
  | { type: 'ChannelDtmfReceived'; channel: AriChannel; digit: string; duration_ms: number }
  | { type: 'ChannelVarset'; channel?: AriChannel; variable: string; value: string }
  | { type: 'Dial'; peer: AriChannel; dialstatus: string }
  | { type: 'BridgeDestroyed'; bridge: { id: string } };

const EVENT_TYPES = new Set<AriEvent['type']>([
  'StasisStart',
  'StasisEnd',
  'ChannelStateChange',
  'ChannelDestroyed',
  'ChannelHangupRequest',
  'ChannelDtmfReceived',
  'ChannelVarset',
  'Dial',
  'BridgeDestroyed',
]);

/** A failed ARI request: the operation and status only (never the URL or the body). */
export class AriError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
  ) {
    super(`ari ${op} failed (${status})`);
    this.name = 'AriError';
  }
}

export interface OriginateInput {
  channelId: string;
  /** `PJSIP/<number>@<trunk endpoint>` */
  endpoint: string;
  callerId: string;
  timeoutSec: number;
  appArgs: string;
  /** Dialplan instead of the app (answering machine detection runs there first). */
  dialplan?: { context: string; extension: string };
  variables?: Record<string, string>;
}

export interface ExternalMediaInput {
  channelId: string;
  /** `host:port` Asterisk sends our RTP to. */
  externalHost: string;
  format: 'ulaw' | 'alaw';
}

type AriEvents = {
  event: (event: AriEvent) => void;
  state: (connected: boolean) => void;
};

const DEFAULT_TIMEOUT_MS = 3000;

export class AriClient extends TypedEmitter<AriEvents> {
  private socket: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private closed = false;
  private isConnected = false;
  private readonly auth: string;

  constructor(private readonly config: AriConfig) {
    super();
    this.auth = `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** Opens the event socket; keeps reconnecting until `close()`. */
  connect(): void {
    this.closed = false;
    this.open();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.removeAllListeners();
    this.socket?.terminate();
    this.socket = null;
    this.setConnected(false);
  }

  private open(): void {
    const url = new URL('/ari/events', this.config.url.replace(/^http/, 'ws'));
    url.searchParams.set('app', this.config.app);
    url.searchParams.set('subscribeAll', 'false');
    const socket = new WebSocket(url, { headers: { authorization: this.auth } });
    this.socket = socket;
    socket.on('open', () => {
      this.attempt = 0;
      this.setConnected(true);
    });
    socket.on('message', (data: RawData) => this.onMessage(data));
    socket.on('error', () => {
      // 'close' follows and schedules the retry.
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setConnected(false);
      this.scheduleRetry();
    });
  }

  private scheduleRetry(): void {
    if (this.closed) return;
    const min = this.config.reconnectMinMs ?? 500;
    const max = this.config.reconnectMaxMs ?? 10_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    this.attempt += 1;
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private setConnected(value: boolean): void {
    if (this.isConnected === value) return;
    this.isConnected = value;
    this.emit('state', value);
  }

  private onMessage(data: RawData): void {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : Buffer.from(new Uint8Array(data)).toString('utf8');
    let event: { type?: unknown };
    try {
      event = JSON.parse(text) as { type?: unknown };
    } catch {
      return;
    }
    if (typeof event.type !== 'string' || !EVENT_TYPES.has(event.type as AriEvent['type'])) return;
    this.emit('event', event as AriEvent);
  }

  private async request<T>(
    op: string,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(`/ari${path}`, this.config.url);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { authorization: this.auth };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new AriError(op, 0);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new AriError(op, res.status);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  originate(input: OriginateInput): Promise<AriChannel> {
    const target = input.dialplan
      ? { context: input.dialplan.context, extension: input.dialplan.extension, priority: 1 }
      : { app: this.config.app, appArgs: input.appArgs };
    return this.request<AriChannel>(
      'originate',
      'POST',
      `/channels/${encodeURIComponent(input.channelId)}`,
      { endpoint: input.endpoint, callerId: input.callerId, timeout: input.timeoutSec, ...target },
      { variables: input.variables ?? {} },
    );
  }

  async answer(channelId: string): Promise<void> {
    await this.request('answer', 'POST', `/channels/${encodeURIComponent(channelId)}/answer`);
  }

  async hangup(channelId: string, reason = 'normal'): Promise<void> {
    await this.request('hangup', 'DELETE', `/channels/${encodeURIComponent(channelId)}`, {
      reason,
    });
  }

  /** https://docs.asterisk.org/Latest_API/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/#senddtmf */
  async sendDigits(channelId: string, digits: string): Promise<void> {
    if (!/^[0-9*#A-D]{1,32}$/.test(digits)) throw new RangeError('Invalid keypad input');
    await this.request('sendDigits', 'POST', `/channels/${encodeURIComponent(channelId)}/dtmf`, {
      dtmf: digits,
    });
  }

  externalMedia(input: ExternalMediaInput): Promise<AriChannel> {
    return this.request<AriChannel>('externalMedia', 'POST', '/channels/externalMedia', {
      channelId: input.channelId,
      app: this.config.app,
      external_host: input.externalHost,
      format: input.format,
      encapsulation: 'rtp',
      transport: 'udp',
      direction: 'both',
    });
  }

  async createBridge(bridgeId: string): Promise<void> {
    await this.request('createBridge', 'POST', `/bridges/${encodeURIComponent(bridgeId)}`, {
      type: 'mixing',
    });
  }

  async addToBridge(bridgeId: string, channelIds: string[]): Promise<void> {
    await this.request(
      'addToBridge',
      'POST',
      `/bridges/${encodeURIComponent(bridgeId)}/addChannel`,
      { channel: channelIds.join(',') },
    );
  }

  async removeFromBridge(bridgeId: string, channelIds: string[]): Promise<void> {
    await this.request(
      'removeFromBridge',
      'POST',
      `/bridges/${encodeURIComponent(bridgeId)}/removeChannel`,
      { channel: channelIds.join(',') },
    );
  }

  async destroyBridge(bridgeId: string): Promise<void> {
    await this.request('destroyBridge', 'DELETE', `/bridges/${encodeURIComponent(bridgeId)}`);
  }

  async getVar(channelId: string, variable: string): Promise<string | null> {
    try {
      const res = await this.request<{ value: string }>(
        'getVar',
        'GET',
        `/channels/${encodeURIComponent(channelId)}/variable`,
        { variable },
      );
      return res.value;
    } catch (err) {
      if (err instanceof AriError && err.status === 404) return null;
      throw err;
    }
  }

  listChannels(): Promise<AriChannel[]> {
    return this.request<AriChannel[]>('listChannels', 'GET', '/channels');
  }

  info(): Promise<{ system?: { version?: string } }> {
    return this.request('info', 'GET', '/asterisk/info');
  }
}
