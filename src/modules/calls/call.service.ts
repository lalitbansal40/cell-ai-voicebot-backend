import { Types } from 'mongoose';

import { CALL_LIMITS, CALL_LINES } from '../../config/limits';
import { notifyAccount } from '../../core/realtime/notify';
import type { WsTicketService } from '../../core/realtime/ws-tickets';
import type { StorageProvider } from '../../core/storage';
import type { AttachResult, MediaAttachInput } from '../../core/telephony/media-server';
import { MEDIA_CLOSE } from '../../core/telephony/media-server';
import type { CallLeg } from '../../core/telephony/types';
import { systemClock, type Clock } from '../../core/voice/clock';
import type { TtsCache } from '../../core/voice/tts-cache';
import { AccountModel, DEFAULT_ACCOUNT_SETTINGS } from '../../db/models/account.model';
import { CallModel, type CallDoc, type CallSource } from '../../db/models/call.model';
import { AppError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';

import { CallBilling } from './billing';
import { issueMediaTicket } from './media-tickets';
import type { CallRegistry } from './registry';
import { CallSession, type CallEndedSummary, type CallScript } from './session';

export interface CreateWebCallInput {
  accountId: string;
  userId: string;
  source: CallSource;
  contactId: string | null;
  /** Display values (allowed contact fields + flow values). */
  variables: Record<string, string>;
  /** Typed tester values (no contact) and the optional test phone. */
  manualVariables?: Record<string, string> | null;
  testPhone?: string | null;
}

export interface CallManagerDeps {
  logger: Logger;
  registry: CallRegistry;
  tts: TtsCache;
  storage: StorageProvider | undefined;
  recordingDir: string;
  /** Builds the program of a call when its socket attaches (flow host / AI agent). */
  scriptFor: (call: CallDoc) => Promise<{ script: CallScript; voice: string; language: string }>;
  tickets?: Pick<WsTicketService, 'issue'>;
  clock?: Clock;
}

export type CallEndedListener = (summary: CallEndedSummary) => void;

/** Calls of this process: creation, socket attach, live sessions, shutdown. */
export class CallManager {
  private readonly sessions = new Map<string, CallSession>();
  private readonly waiting = new Map<string, unknown>();
  private readonly listeners: CallEndedListener[] = [];
  private readonly clock: Clock;

  constructor(private readonly deps: CallManagerDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Live sessions + calls waiting for their socket on this process. */
  get load(): number {
    return this.sessions.size + this.waiting.size;
  }

  onCallEnded(listener: CallEndedListener): void {
    this.listeners.push(listener);
  }

  /**
   * A browser test call: limits → call doc (queued) → wallet hold → media ticket.
   * A refused hold leaves no call behind.
   */
  async createWebCall(input: CreateWebCallInput) {
    if (this.load >= CALL_LIMITS.concurrentPerProcess) throw new AppError('CALL_CAPACITY');
    const live = await this.deps.registry.liveCalls(input.accountId);
    if (live.length >= CALL_LIMITS.concurrentPerAccount) throw new AppError('CALL_LIMIT_REACHED');
    const call = await CallModel.create({
      accountId: input.accountId,
      direction: 'outbound',
      provider: 'webcall',
      from: 'webcall',
      to: `webcall:${input.userId}`,
      isTest: true,
      source: input.source,
      contactId: input.contactId,
      startedBy: input.userId,
      variables: input.variables,
      manualVariables: input.manualVariables ?? null,
      testPhone: input.testPhone ?? null,
      timestamps: { queuedAt: new Date(this.clock.now()) },
    });
    const callId = call._id.toString();
    const billing = new CallBilling(input.accountId, callId, false);
    try {
      await billing.hold();
    } catch (err) {
      await CallModel.deleteOne({ _id: call._id });
      throw err;
    }
    await CallModel.updateOne({ _id: call._id }, { $set: { holdId: billing.holdId } });
    // the browser has the ticket TTL + the ready timeout to connect
    const waitMs = (60 + CALL_LIMITS.readyTimeoutSec) * 1000;
    await this.deps.registry.register(
      callId,
      input.accountId,
      this.clock.now(),
      Math.ceil(waitMs / 1000),
    );
    this.waiting.set(
      callId,
      this.clock.setTimeout(() => void this.cancelUnattached(callId, input.accountId), waitMs),
    );
    const ticket = await issueMediaTicket(
      { userId: input.userId, accountId: input.accountId, callId },
      this.deps.tickets,
    );
    notifyAccount(input.accountId, 'call.created', { callId, isTest: true });
    return {
      callId,
      call: { ...call.toObject({ transform: false }), testPhone: null, holdId: billing.holdId },
      ...ticket,
    };
  }

  /** Media server hook: the call's socket arrived. */
  attach = async (input: MediaAttachInput, leg: CallLeg): Promise<AttachResult> => {
    if (!Types.ObjectId.isValid(input.callId))
      return { ok: false, code: MEDIA_CLOSE.callEnded, reason: 'unknown call' };
    const call = await CallModel.findOne({
      _id: input.callId,
      accountId: input.accountId,
    }).lean<CallDoc>();
    if (!call) return { ok: false, code: MEDIA_CLOSE.callEnded, reason: 'unknown call' };
    if (call.startedBy?.toString() !== input.userId)
      return { ok: false, code: MEDIA_CLOSE.forbidden, reason: 'not your call' };
    if (call.status !== 'queued' || this.sessions.has(input.callId)) {
      return { ok: false, code: MEDIA_CLOSE.callEnded, reason: 'call ended' };
    }
    const timer = this.waiting.get(input.callId);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.waiting.delete(input.callId);
    const account = await AccountModel.findById(call.accountId).select({ settings: 1 }).lean();
    const settings = { ...DEFAULT_ACCOUNT_SETTINGS, ...account?.settings };
    const { script, voice, language } = await this.deps.scriptFor(call);
    const billing = new CallBilling(input.accountId, input.callId, false);
    billing.holdId = call.holdId?.toString() ?? null;
    const session = new CallSession({
      call,
      leg,
      clock: this.clock,
      logger: this.deps.logger,
      tts: this.deps.tts,
      storage: this.deps.storage,
      registry: this.deps.registry,
      billing,
      script,
      recordingDir: this.deps.recordingDir,
      recording: { enabled: settings.recordingEnabled, notice: settings.recordingNotice },
      voice,
      language,
      onEnded: (summary) => {
        this.sessions.delete(input.callId);
        for (const listener of this.listeners) listener(summary);
      },
    });
    this.sessions.set(input.callId, session);
    await session.start();
    return { ok: true };
  };

  /** Hang up a live call of this account from another tab (409 when not running here). */
  async hangup(accountId: string, callId: string): Promise<CallEndedSummary> {
    const session = this.sessions.get(callId);
    if (!session || session.accountId !== accountId || session.ended) {
      throw new AppError('CALL_NOT_ACTIVE');
    }
    return session.end('customer_hangup');
  }

  isLiveHere(callId: string): boolean {
    return this.sessions.has(callId);
  }

  /** SIGTERM: every live call says the technical line (≤ 5 s), hangs up and settles. */
  async shutdown(): Promise<void> {
    for (const [callId, timer] of this.waiting) {
      this.clock.clearTimeout(timer);
      this.waiting.delete(callId);
    }
    await Promise.all(
      [...this.sessions.values()].map((s) => s.politeEnd(CALL_LINES.technical, 'server_shutdown')),
    );
  }

  private async cancelUnattached(callId: string, accountId: string): Promise<void> {
    this.waiting.delete(callId);
    const call = await CallModel.findOneAndUpdate(
      { _id: callId, status: 'queued' },
      {
        $set: {
          status: 'canceled',
          endReason: 'canceled',
          'timestamps.endedAt': new Date(this.clock.now()),
        },
      },
      { returnDocument: 'after' },
    ).lean<CallDoc>();
    if (!call) return;
    const billing = new CallBilling(accountId, callId, false);
    billing.holdId = call.holdId?.toString() ?? null;
    await billing
      .release('not_connected')
      .catch((err: unknown) => this.deps.logger.error({ err, callId }, 'call: release failed'));
    await this.deps.registry.unregister(callId, accountId).catch(() => undefined);
    notifyAccount(accountId, 'call.status', { callId, status: 'canceled' });
  }
}
