import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

export type WsChannel = 'events' | 'media';

export interface WsTicketPayload {
  userId: string;
  accountId: string;
  channel: WsChannel;
  /** Expiry (epoch ms) stored inside the ticket too — lets us report 4010 on clock-skewed reuse. */
  exp: number;
}

export type ConsumeResult =
  { status: 'ok'; payload: WsTicketPayload } | { status: 'invalid' } | { status: 'expired' };

export const TICKET_TTL_SEC = 60;

/** Single-use WebSocket tickets in Redis (docs/conventions/websocket.md §2). */
export class WsTicketService {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'wst:',
    private readonly ttlSec = TICKET_TTL_SEC,
  ) {}

  async issue(input: {
    userId: string;
    accountId: string;
    channel: WsChannel;
  }): Promise<{ ticket: string; expiresAt: string }> {
    const ticket = `wst_${randomBytes(32).toString('base64url')}`;
    const exp = Date.now() + this.ttlSec * 1000;
    const payload: WsTicketPayload = { ...input, exp };
    const ok = await this.redis.set(
      `${this.keyPrefix}${ticket}`,
      JSON.stringify(payload),
      'EX',
      this.ttlSec,
      'NX',
    );
    if (ok !== 'OK') throw new Error('Could not store WebSocket ticket');
    return { ticket, expiresAt: new Date(exp).toISOString() };
  }

  /** Atomically reads and deletes the ticket (GETDEL) — a ticket works once. */
  async consume(ticket: string | null | undefined, now = Date.now()): Promise<ConsumeResult> {
    if (!ticket || !/^wst_[A-Za-z0-9_-]{20,}$/.test(ticket)) return { status: 'invalid' };
    const raw = await this.redis.getdel(`${this.keyPrefix}${ticket}`);
    if (!raw) return { status: 'invalid' };
    let payload: WsTicketPayload;
    try {
      payload = JSON.parse(raw) as WsTicketPayload;
    } catch {
      return { status: 'invalid' };
    }
    if (payload.exp <= now) return { status: 'expired' };
    return { status: 'ok', payload };
  }
}
