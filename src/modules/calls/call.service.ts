import { Types } from 'mongoose';

import { CALL_LIMITS, CALL_LINES } from '../../config/limits';
import { notifyAccount } from '../../core/realtime/notify';
import type { WsTicketService } from '../../core/realtime/ws-tickets';
import type { StorageProvider } from '../../core/storage';
import { DryRunProvider, type DryRunSettings } from '../../core/telephony/dryrun';
import type { AttachResult, MediaAttachInput } from '../../core/telephony/media-server';
import { MEDIA_CLOSE } from '../../core/telephony/media-server';
import type { CallLeg } from '../../core/telephony/types';
import { systemClock, type Clock } from '../../core/voice/clock';
import { ScaledClock } from '../../core/voice/scaled-clock';
import type { TtsCache } from '../../core/voice/tts-cache';
import { isDuplicateKeyError } from '../../db/errors';
import {
  AccountModel,
  DEFAULT_ACCOUNT_LIMITS,
  DEFAULT_ACCOUNT_SETTINGS,
  type AccountLimits,
} from '../../db/models/account.model';
import { CallModel, type CallDoc, type CallSource } from '../../db/models/call.model';
import { AppError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { DialSlots, type SlotLease } from '../campaigns/slots';
import type { CallControlBus } from '../whatsapp-calling/bus';

import { CallBilling } from './billing';
import { issueMediaTicket } from './media-tickets';
import type { CallRegistry } from './registry';
import type { ScriptChoice, ScriptFactory } from './scripts';
import { CallSession, type CallEndedSummary } from './session';
import { VirtualCallBilling, type VirtualGate } from './virtual-billing';

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
  scriptFor: (call: CallDoc) => Promise<ScriptChoice>;
  tickets?: Pick<WsTicketService, 'issue'>;
  clock?: Clock;
  /** Atomic dial slots (default: on the registry's Redis connection and prefix). */
  slots?: DialSlots;
  /** Dry-run calls: programs on the fake voice + fake AI, TTS without the storage cache. */
  dryRun?: { scriptFor: ScriptFactory; tts: Pick<TtsCache, 'get'> };
}

/** A phone call placed by a campaign or "Call now" (PHASE_8_PLAN §1c). */
export interface StartOutboundCallInput {
  accountId: string;
  /** Phase 8 has the dry-run line only; `sip` arrives in Phase 13. */
  provider: 'dryrun' | 'sip';
  /** E.164, server-only. */
  to: string;
  contactId: string;
  source: CallSource;
  /** Display values (the snapshot of the fields the flow uses). */
  variables: Record<string, string>;
  campaign?: { campaignId: string; campaignContactId: string; attempt: number };
  /** The user of a single "Call now"; `null` for campaign calls. */
  initiatedBy: string | null;
  /** Campaign concurrency (the group slot limit); single calls use the web group (3). */
  groupLimit?: number;
  dryRun?: DryRunSettings & { speed: number; gate?: VirtualGate };
}

export interface OutboundCall {
  callId: string;
  /** Resolves with the summary once the call ended (any way). */
  ended: Promise<CallEndedSummary>;
}

/** May return a promise: `shutdown()` waits for it (e.g. campaign results written before Mongo closes). */
export type CallEndedListener = (summary: CallEndedSummary) => void | Promise<unknown>;

/** Calls of this process: creation, socket attach, live sessions, shutdown. */
export class CallManager {
  private readonly sessions = new Map<string, CallSession>();
  private readonly waiting = new Map<string, unknown>();
  private readonly listeners: CallEndedListener[] = [];
  private readonly listening = new Set<Promise<unknown>>();
  private readonly clock: Clock;
  readonly slots: DialSlots;
  /** Slot leases of this process's calls, refreshed with the heartbeat. */
  private readonly leases = new Map<string, SlotLease>();
  private leaseTimer: unknown = null;
  private readonly dryRunLine = new DryRunProvider();
  /** Live campaign calls of this process: call id → campaign id (cancel with hang-up). */
  private readonly campaignCalls = new Map<string, string>();
  /** Campaign calls hung up before their session existed — ended right after it starts. */
  private readonly endRequested = new Set<string>();
  /** Phase 12: routes hangups between processes (`attachBus`). */
  private bus: CallControlBus | null = null;

  constructor(private readonly deps: CallManagerDeps) {
    this.clock = deps.clock ?? systemClock;
    this.slots =
      deps.slots ??
      new DialSlots(deps.registry.redis, deps.registry.prefix, () => this.clock.now());
  }

  /**
   * Phase 12: this process's live calls are found by other processes (cross-process
   * hangup for every provider) and their hangups reach the session here.
   */
  attachBus(bus: CallControlBus): void {
    this.bus = bus;
    bus.onHangup(async (callId) => {
      const session = this.sessions.get(callId);
      if (!session || session.ended) return false;
      await session.end('customer_hangup');
      return true;
    });
    for (const callId of this.sessions.keys()) void bus.ownCall(callId);
  }

  private track(callId: string, session: CallSession): void {
    this.sessions.set(callId, session);
    void this.bus
      ?.ownCall(callId)
      .catch((err: unknown) => this.deps.logger.warn({ err }, 'call: bus register failed'));
  }

  private untrack(callId: string): void {
    this.sessions.delete(callId);
    void this.bus?.releaseCall(callId).catch(() => undefined);
  }

  /** Keeps a call's slot lease alive until `releaseLease`. */
  keepLease(callId: string, lease: SlotLease): void {
    this.leases.set(callId, lease);
    this.leaseTimer ??= this.clock.setInterval(() => {
      for (const l of this.leases.values()) {
        void this.slots
          .refresh(l)
          .catch((err: unknown) => this.deps.logger.warn({ err }, 'call: slot refresh failed'));
      }
    }, CALL_LIMITS.heartbeatSec * 1000);
  }

  async releaseLease(callId: string): Promise<void> {
    const lease = this.leases.get(callId);
    if (!lease) return;
    this.leases.delete(callId);
    if (this.leases.size === 0 && this.leaseTimer !== null) {
      this.clock.clearInterval(this.leaseTimer);
      this.leaseTimer = null;
    }
    await this.slots
      .release(lease)
      .catch((err: unknown) => this.deps.logger.warn({ err, callId }, 'call: slot release failed'));
  }

  /** Dialing limits of an account (superadmin-set, Phase 8). */
  async accountLimits(accountId: string): Promise<AccountLimits> {
    const account = await AccountModel.findById(accountId)
      .select({ limits: 1 })
      .lean<{ limits?: Partial<AccountLimits> }>();
    return { ...DEFAULT_ACCOUNT_LIMITS, ...account?.limits };
  }

  /** Live sessions + calls waiting for their socket on this process. */
  get load(): number {
    return this.sessions.size + this.waiting.size;
  }

  onCallEnded(listener: CallEndedListener): void {
    this.listeners.push(listener);
  }

  private emitEnded(summary: CallEndedSummary): void {
    for (const listener of this.listeners) {
      const work = listener(summary);
      if (!work) continue;
      const tracked = work.then(
        () => undefined,
        () => undefined,
      );
      this.listening.add(tracked);
      void tracked.finally(() => this.listening.delete(tracked));
    }
  }

  /**
   * A browser test call: limits → call doc (queued) → wallet hold → media ticket.
   * A refused hold leaves no call behind.
   */
  async createWebCall(input: CreateWebCallInput) {
    if (this.load >= CALL_LIMITS.concurrentPerProcess) throw new AppError('CALL_CAPACITY');
    const id = new Types.ObjectId();
    const callId = id.toString();
    const limits = await this.accountLimits(input.accountId);
    // atomic: two creates at the same moment can't both take the last slot
    const slot = await this.slots.acquire({
      accountId: input.accountId,
      campaignId: null,
      member: callId,
      limits: {
        account: limits.maxConcurrentCalls,
        group: CALL_LIMITS.concurrentPerAccount,
        process: CALL_LIMITS.concurrentPerProcess,
      },
    });
    if (!slot.ok) {
      throw new AppError(slot.scope === 'process' ? 'CALL_CAPACITY' : 'CALL_LIMIT_REACHED');
    }
    this.keepLease(callId, slot.lease);
    const call = await CallModel.create({
      _id: id,
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
    const billing = new CallBilling(input.accountId, callId, false);
    try {
      await billing.hold();
    } catch (err) {
      await CallModel.deleteOne({ _id: call._id });
      await this.releaseLease(callId);
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

  /**
   * A phone call — a campaign attempt or a single "Call now" (PHASE_8_PLAN §1c):
   * slot → call doc → billing → the line → session. Phase 8 has the dry-run
   * line only (simulated customer on virtual time, priced but never charged).
   */
  async startOutboundCall(input: StartOutboundCallInput): Promise<OutboundCall> {
    const dry = this.deps.dryRun;
    if (input.provider !== 'dryrun' || !input.dryRun || !dry) {
      throw new AppError('CAMPAIGN_NOT_RUNNABLE', 'Phone calls need a SIP line (Phase 13).');
    }
    const id = new Types.ObjectId();
    const callId = id.toString();
    const limits = await this.accountLimits(input.accountId);
    const slot = await this.slots.acquire({
      accountId: input.accountId,
      campaignId: input.campaign?.campaignId ?? null,
      member: callId,
      limits: {
        account: limits.maxConcurrentCalls,
        group: input.groupLimit ?? CALL_LIMITS.concurrentPerAccount,
        process: CALL_LIMITS.concurrentPerProcess,
      },
    });
    if (!slot.ok) {
      throw new AppError(slot.scope === 'process' ? 'CALL_CAPACITY' : 'CALL_LIMIT_REACHED');
    }
    this.keepLease(callId, slot.lease);
    const billing = new VirtualCallBilling(
      input.accountId,
      input.dryRun.gate ?? (() => Promise.resolve(true)),
    );
    let call: CallDoc;
    try {
      if (!(await billing.canStart())) throw new AppError('WALLET_INSUFFICIENT_BALANCE');
      const created = await CallModel.create({
        _id: id,
        accountId: input.accountId,
        direction: 'outbound',
        provider: 'dryrun',
        from: 'dryrun',
        to: input.to,
        isTest: true,
        charged: false,
        source: input.source,
        contactId: input.contactId,
        campaignId: input.campaign?.campaignId ?? null,
        campaignContactId: input.campaign?.campaignContactId ?? null,
        attempt: input.campaign?.attempt ?? null,
        startedBy: input.initiatedBy,
        variables: input.variables,
        timestamps: { queuedAt: new Date(this.clock.now()) },
      });
      call = created.toObject({ transform: false });
    } catch (err) {
      await this.releaseLease(callId);
      if (isDuplicateKeyError(err)) {
        throw new AppError('CONFLICT_INVALID_STATE', 'This attempt was already dialed.');
      }
      throw err;
    }
    const campaignId = input.campaign?.campaignId;
    // known to hangupCampaign from now on (the session follows after the awaits below)
    if (campaignId) this.campaignCalls.set(callId, campaignId);
    notifyAccount(input.accountId, 'call.created', {
      callId,
      isTest: true,
      ...(campaignId ? { campaignId } : {}),
    });
    // a program that can't be built ends the call as an engine error (one path)
    const choice: ScriptChoice = await dry.scriptFor(call).catch((err: unknown) => {
      this.deps.logger.error({ err, callId }, 'call: dry-run program failed');
      return { script: failingScript(err), voice: 'coral', language: 'hinglish' };
    });
    const clock = new ScaledClock(input.dryRun.speed, this.clock);
    try {
      await this.deps.registry.register(
        callId,
        input.accountId,
        clock.now(),
        CALL_LIMITS.registryTtlSec,
      );
    } catch (err) {
      this.campaignCalls.delete(callId);
      this.endRequested.delete(callId);
      await this.releaseLease(callId);
      throw err;
    }
    const leg = this.dryRunLine.startCall({ callId, to: input.to, dryRun: input.dryRun, clock });
    let resolveEnded: (summary: CallEndedSummary) => void = () => undefined;
    const ended = new Promise<CallEndedSummary>((resolve) => {
      resolveEnded = resolve;
    });
    const session = new CallSession({
      call,
      leg,
      clock,
      logger: this.deps.logger,
      tts: dry.tts,
      storage: this.deps.storage,
      registry: this.deps.registry,
      billing,
      script: choice.script,
      recordingDir: this.deps.recordingDir,
      recording: { enabled: false, notice: '' },
      voice: choice.voice,
      language: choice.language,
      ...(choice.maxDurationSec !== undefined ? { maxDurationSec: choice.maxDurationSec } : {}),
      media: 'none',
      onEnded: (summary) => {
        this.untrack(callId);
        this.campaignCalls.delete(callId);
        this.endRequested.delete(callId);
        void this.releaseLease(callId);
        this.emitEnded(summary);
        resolveEnded(summary);
      },
    });
    this.track(callId, session);
    await session.start();
    if (this.endRequested.delete(callId)) await session.end('campaign_canceled');
    else leg.ring();
    return { callId, ended };
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
    const { script, voice, language, maxDurationSec } = await this.deps.scriptFor(call);
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
      maxDurationSec,
      onEnded: (summary) => {
        this.untrack(input.callId);
        void this.releaseLease(input.callId);
        this.emitEnded(summary);
      },
    });
    this.track(input.callId, session);
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

  /**
   * Hang up from any process (Phase 12): here when the call runs here, else handed
   * to its process over the call bus (`forwarded`). 409 when no process holds it.
   * The caller has checked the call belongs to the account.
   */
  async hangupAnywhere(accountId: string, callId: string): Promise<'local' | 'forwarded'> {
    if (this.sessions.has(callId) || !this.bus) {
      await this.hangup(accountId, callId);
      return 'local';
    }
    const result = await this.bus.hangup(callId, 'customer_hangup');
    if (result === 'not_live') throw new AppError('CALL_NOT_ACTIVE');
    return result;
  }

  /** Ends every live call of a campaign on this process (cancel with hang-up). */
  async hangupCampaign(campaignId: string): Promise<number> {
    const ids = [...this.campaignCalls].filter(([, c]) => c === campaignId).map(([id]) => id);
    const live = ids.flatMap((id) => {
      const session = this.sessions.get(id);
      if (!session) this.endRequested.add(id);
      return session ? [session] : [];
    });
    await Promise.all(live.map((session) => session.end('campaign_canceled')));
    return ids.length;
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
    // listeners' work for the calls that just ended (and earlier ones still running)
    await Promise.all([...this.listening]);
  }

  private async cancelUnattached(callId: string, accountId: string): Promise<void> {
    this.waiting.delete(callId);
    await this.releaseLease(callId);
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

/** The program of a call whose flow / agent could not be loaded: ends it as an engine error. */
const failingScript = (err: unknown) => ({
  run: () => Promise.reject(err instanceof Error ? err : new Error('program unavailable')),
  stop: () => Promise.resolve(),
  result: () => ({
    outcome: {},
    disposition: null,
    variables: {},
    languageDetected: null,
    aiSeconds: 0,
    flowRunId: null,
  }),
});
