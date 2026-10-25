import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import type { Redis } from 'ioredis';

import { CALL_LIMITS, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { AppError } from '../../shared/errors/app-error';
import type { ErrorCode } from '../../shared/errors/error-codes';
import { getLogger } from '../../shared/logger';

/**
 * Call-control bus (PHASE_12_PROMPT §1): WhatsApp calls (and, for hangups, every
 * Phase 7 call) are owned by one process — the one holding the media. Other
 * processes reach the owner through Redis pub / sub:
 *
 * - `call:wa:owner:<waCallId>` → node id (TTL `ownerTtlSec`, refreshed every `heartbeatSec`);
 * - `call:node:<callId>` → node id of any live call (cross-process hangup);
 * - `call:wa:claim:<waCallId>` — `SET NX`: exactly one node takes an inbound call;
 * - `call:wa:answer:<callId>` — `SET NX`: the first team member to answer wins;
 * - channels `call:ctl:<nodeId>` (to one node) and `call:ctl:inbound` (to every node).
 *
 * Messages carry ids and kinds only — never SDP, phones or names.
 */
export type BusMessage =
  /** A stored `calls` webhook event (fast path; the worker processes the same row too). */
  | { type: 'calls_event'; eventId: string; waCallId: string; kind: string }
  /** Hang up a live call owned by the receiving node (any provider). */
  | { type: 'hangup'; callId: string; cause: 'customer_hangup' | 'normal' }
  /** Anything a call handler wants to send its owner (answer, transfer, keys…). */
  | { type: 'call'; waCallId: string; action: string; data?: Record<string, unknown> };

export interface CallCommand {
  callId: string;
  action: 'answer' | 'decline' | 'hold' | 'transfer' | 'media_ticket';
  accountId: string;
  userId: string;
  on?: boolean;
  targetUserId?: string;
}

type RpcMessage =
  | { type: 'command'; id: string; replyTo: string; command: CallCommand }
  | { type: 'command_result'; id: string; result?: unknown; error?: ErrorCode };

export type BusHandler = (message: BusMessage) => void | Promise<void>;

export interface CallBusOptions {
  /** Commands (GET / SET / PUBLISH). */
  redis: Redis;
  /** A dedicated connection for SUBSCRIBE (a subscribed connection can't run commands). */
  subscriber: Redis;
  prefix?: string;
  nodeId?: string;
  /** Live WhatsApp media calls on this node and the most it takes (inbound claims). */
  capacity?: () => { active: number; max: number };
}

export const createNodeId = (): string =>
  `${hostname()}:${String(process.pid)}:${randomBytes(4).toString('hex')}`;

export class CallControlBus {
  readonly nodeId: string;
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly prefix: string;
  private readonly capacity: () => { active: number; max: number };
  private readonly owned = new Set<string>();
  private readonly ownedCalls = new Set<string>();
  private readonly callHandlers = new Map<string, BusHandler>();
  private readonly hangupHandlers = new Set<(callId: string, cause: string) => Promise<boolean>>();
  private readonly inboundHandlers = new Set<BusHandler>();
  private heartbeat: NodeJS.Timeout | null = null;
  private started = false;
  private commandHandler: ((command: CallCommand) => Promise<unknown>) | null = null;
  private readonly requests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(options: CallBusOptions) {
    this.redis = options.redis;
    this.subscriber = options.subscriber;
    this.prefix = options.prefix ?? '';
    this.nodeId = options.nodeId ?? createNodeId();
    this.capacity = options.capacity ?? (() => ({ active: 0, max: Number.POSITIVE_INFINITY }));
  }

  private k(name: string): string {
    return `${this.prefix}${name}`;
  }

  private nodeChannel(nodeId: string): string {
    return this.k(`call:ctl:${nodeId}`);
  }

  private get inboundChannel(): string {
    return this.k('call:ctl:inbound');
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.subscriber.on('message', (channel: string, raw: string) => {
      void this.dispatch(channel, raw);
    });
    await this.subscriber.subscribe(this.nodeChannel(this.nodeId), this.inboundChannel);
    this.heartbeat = setInterval(() => {
      void this.refresh().catch((err: unknown) => {
        getLogger().warn({ errName: (err as Error).name }, 'call bus: heartbeat failed');
      });
    }, CALL_LIMITS.heartbeatSec * 1000);
    this.heartbeat.unref();
  }

  async stop(): Promise<void> {
    for (const request of this.requests.values()) {
      clearTimeout(request.timer);
      request.reject(new AppError('CALL_NOT_ACTIVE'));
    }
    this.requests.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.started) {
      this.started = false;
      await this.subscriber.unsubscribe().catch(() => undefined);
    }
    this.subscriber.removeAllListeners('message');
    await Promise.all([...this.owned].map((id) => this.release(id)));
    await Promise.all([...this.ownedCalls].map((id) => this.releaseCall(id)));
  }

  /* ── ownership ── */

  /** This node holds the media of `waCallId` (refreshed until `release`). */
  async own(waCallId: string, handler?: BusHandler): Promise<void> {
    this.owned.add(waCallId);
    if (handler) this.callHandlers.set(waCallId, handler);
    await this.redis.set(
      this.k(`call:wa:owner:${waCallId}`),
      this.nodeId,
      'EX',
      WHATSAPP_CALL_LIMITS.ownerTtlSec,
    );
  }

  async release(waCallId: string): Promise<void> {
    this.owned.delete(waCallId);
    this.callHandlers.delete(waCallId);
    // only our own key (another node may own it by now)
    const key = this.k(`call:wa:owner:${waCallId}`);
    if ((await this.redis.get(key)) === this.nodeId) await this.redis.del(key);
  }

  ownerOf(waCallId: string): Promise<string | null> {
    return this.redis.get(this.k(`call:wa:owner:${waCallId}`));
  }

  /** Any live call (all providers) runs on this node — hangups find it. */
  async ownCall(callId: string): Promise<void> {
    this.ownedCalls.add(callId);
    await this.redis.set(
      this.k(`call:node:${callId}`),
      this.nodeId,
      'EX',
      WHATSAPP_CALL_LIMITS.ownerTtlSec,
    );
  }

  async releaseCall(callId: string): Promise<void> {
    this.ownedCalls.delete(callId);
    const key = this.k(`call:node:${callId}`);
    if ((await this.redis.get(key)) === this.nodeId) await this.redis.del(key);
  }

  nodeOfCall(callId: string): Promise<string | null> {
    return this.redis.get(this.k(`call:node:${callId}`));
  }

  private async refresh(): Promise<void> {
    const ttl = WHATSAPP_CALL_LIMITS.ownerTtlSec;
    for (const id of this.owned) {
      await this.redis.set(this.k(`call:wa:owner:${id}`), this.nodeId, 'EX', ttl);
    }
    for (const id of this.ownedCalls) {
      await this.redis.set(this.k(`call:node:${id}`), this.nodeId, 'EX', ttl);
    }
  }

  /* ── messages ── */

  /** Sends to the owner of the call: handled here when we own it. */
  async toOwner(
    waCallId: string,
    message: BusMessage,
  ): Promise<'local' | 'forwarded' | 'no_owner'> {
    const owner = await this.ownerOf(waCallId);
    if (!owner) return 'no_owner';
    if (owner === this.nodeId) {
      await this.callHandlers.get(waCallId)?.(message);
      return 'local';
    }
    await this.redis.publish(this.nodeChannel(owner), JSON.stringify(message));
    return 'forwarded';
  }

  /** Every node gets it (inbound calls: each tries `claimInbound`). */
  async toAll(message: BusMessage): Promise<void> {
    await this.redis.publish(this.inboundChannel, JSON.stringify(message));
  }

  onInbound(handler: BusHandler): () => void {
    this.inboundHandlers.add(handler);
    return () => this.inboundHandlers.delete(handler);
  }

  /** Local hangup of a call running here (CallManager); true when it was here. */
  onHangup(handler: (callId: string, cause: string) => Promise<boolean>): () => void {
    this.hangupHandlers.add(handler);
    return () => this.hangupHandlers.delete(handler);
  }

  onCommand(handler: (command: CallCommand) => Promise<unknown>): void {
    this.commandHandler = handler;
  }

  /** Agent actions reach the media owner even when HTTP lands on another API node. */
  async command(command: CallCommand, timeoutMs = 10_000): Promise<unknown> {
    const owner = await this.nodeOfCall(command.callId);
    if (!owner) throw new AppError('CALL_NOT_ACTIVE');
    if (owner === this.nodeId) {
      if (!this.commandHandler) throw new AppError('CALL_NOT_ACTIVE');
      return this.commandHandler(command);
    }
    const id = randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new AppError('CALL_NOT_ACTIVE'));
      }, timeoutMs);
      timer.unref();
      this.requests.set(id, { resolve, reject, timer });
      const message: RpcMessage = { type: 'command', id, replyTo: this.nodeId, command };
      void this.redis
        .publish(this.nodeChannel(owner), JSON.stringify(message))
        .catch((err: unknown) => {
          clearTimeout(timer);
          this.requests.delete(id);
          reject(err instanceof Error ? err : new Error('Call control is unavailable'));
        });
    });
  }

  /**
   * Hangup from any process: here when the call runs here, else forwarded to its
   * node. `not_live` = no node holds it (ended, or its node died).
   */
  async hangup(
    callId: string,
    cause: 'customer_hangup' | 'normal' = 'customer_hangup',
  ): Promise<'local' | 'forwarded' | 'not_live'> {
    if (await this.hangupHere(callId, cause)) return 'local';
    const node = await this.nodeOfCall(callId);
    if (!node || node === this.nodeId) return 'not_live';
    await this.redis.publish(
      this.nodeChannel(node),
      JSON.stringify({ type: 'hangup', callId, cause } satisfies BusMessage),
    );
    return 'forwarded';
  }

  private async hangupHere(callId: string, cause: string): Promise<boolean> {
    for (const fn of this.hangupHandlers) if (await fn(callId, cause)) return true;
    return false;
  }

  /* ── claims ── */

  /** Exactly one node takes an inbound call — only with free capacity. */
  async claimInbound(waCallId: string): Promise<boolean> {
    const { active, max } = this.capacity();
    if (active >= max) return false;
    const ok = await this.redis.set(
      this.k(`call:wa:claim:${waCallId}`),
      this.nodeId,
      'EX',
      WHATSAPP_CALL_LIMITS.claimTtlSec,
      'NX',
    );
    return ok === 'OK';
  }

  /** First answer wins → the winner's user id (this one or an earlier one). */
  async claimAnswer(callId: string, userId: string): Promise<string> {
    const key = this.k(`call:wa:answer:${callId}`);
    const ok = await this.redis.set(key, userId, 'EX', WHATSAPP_CALL_LIMITS.claimTtlSec, 'NX');
    return ok === 'OK' ? userId : ((await this.redis.get(key)) ?? userId);
  }

  /** One agent cannot win two different calls in the same instant. */
  async claimAgent(accountId: string, userId: string, callId: string): Promise<boolean> {
    const key = this.k(`call:wa:agent:${accountId}:${userId}`);
    const ok = await this.redis.set(key, callId, 'EX', CALL_LIMITS.maxCallSecHard + 120, 'NX');
    return ok === 'OK' || (await this.redis.get(key)) === callId;
  }

  async releaseAgent(accountId: string, userId: string, callId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      this.k(`call:wa:agent:${accountId}:${userId}`),
      callId,
    );
  }

  private async dispatch(channel: string, raw: string): Promise<void> {
    let message: BusMessage | RpcMessage;
    try {
      message = JSON.parse(raw) as BusMessage | RpcMessage;
    } catch {
      return;
    }
    try {
      if (message.type === 'command_result') {
        const pending = this.requests.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.requests.delete(message.id);
        if (message.error) pending.reject(new AppError(message.error));
        else pending.resolve(message.result);
        return;
      }
      if (message.type === 'command') {
        const response: RpcMessage = { type: 'command_result', id: message.id };
        try {
          if (!this.commandHandler) throw new AppError('CALL_NOT_ACTIVE');
          response.result = await this.commandHandler(message.command);
        } catch (err) {
          response.error = err instanceof AppError ? err.code : 'WHATSAPP_CALL_FAILED';
        }
        await this.redis.publish(this.nodeChannel(message.replyTo), JSON.stringify(response));
        return;
      }
      if (channel === this.inboundChannel) {
        for (const fn of this.inboundHandlers) await fn(message);
        return;
      }
      if (message.type === 'hangup') {
        await this.hangupHere(message.callId, message.cause);
        return;
      }
      const waCallId = message.waCallId;
      await this.callHandlers.get(waCallId)?.(message);
    } catch (err) {
      getLogger().warn(
        { errName: (err as Error).name, type: message.type },
        'call bus: handler failed',
      );
    }
  }
}
