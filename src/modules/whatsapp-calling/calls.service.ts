import { Types } from 'mongoose';

import { CALL_LIMITS, CALL_LINES, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import {
  callDurationSec,
  callsValueSchema,
  type MetaCallEvent,
  type MetaCallsValue,
} from '../../core/meta';
import { notifyAccount } from '../../core/realtime/notify';
import type { WsTicketService } from '../../core/realtime/ws-tickets';
import type { StorageProvider } from '../../core/storage';
import type { MediaAttachInput, AttachResult } from '../../core/telephony/media-server';
import { MEDIA_CLOSE } from '../../core/telephony/media-server';
import type { CallLeg } from '../../core/telephony/types';
import { WhatsAppCallLeg } from '../../core/telephony/whatsapp/leg';
import { WhatsAppPeer, type PeerOptions } from '../../core/telephony/whatsapp/peer';
import type { Clock } from '../../core/voice/clock';
import { systemClock } from '../../core/voice/clock';
import type { TtsCache } from '../../core/voice/tts-cache';
import {
  AccountModel,
  DEFAULT_ACCOUNT_SETTINGS,
  DEFAULT_WHATSAPP_CALLING_SETTINGS,
  type AccountWhatsAppCallingSettings,
} from '../../db/models/account.model';
import {
  CallModel,
  type CallDoc,
  type CallEndReason,
  type CallSource,
} from '../../db/models/call.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';
import type { CallBillingPort } from '../calls/billing';
import { issueMediaTicket } from '../calls/media-tickets';
import type { CallRegistry } from '../calls/registry';
import type { ScriptChoice } from '../calls/scripts';
import { CallSession, type CallEndedSummary } from '../calls/session';
import type { InboxContext } from '../inbox/context';
import { touchLastMessage, upsertConversation } from '../inbox/conversation-store';
import { emitConversation, emitMessageCreated } from '../inbox/events';
import { blankContent, insertMessage } from '../inbox/message-store';
import { openSecret } from '../whatsapp/context';

import { LATE_TERMINATE_GRACE_MS, quoteCall, WhatsAppCallBilling, type CallQuote } from './billing';
import { BridgeScript } from './bridge';
import type { BusMessage, CallControlBus } from './bus';
import { assertDial } from './dial-guard';
import { callError } from './errors';
import type { CallPermissionsService } from './permissions.service';
import type { CallProgram } from './program';
import type { CallingDeps } from './settings.service';

/**
 * WhatsApp calls (PHASE_12_PLAN §1f, PHASE_12_PROMPT T12.6). This process owns the
 * media of the calls it placed: the `WhatsAppCallLeg`, the Phase 7 `CallSession`
 * (AI script or the agent bridge), the holds and the end. Meta's webhooks reach it
 * through the call bus (fast path + worker, both idempotent by event id and by the
 * session's own state). Never logs SDP, phones, names or digits.
 */
export interface WhatsAppCallsDeps extends CallingDeps {
  bus: CallControlBus;
  permissions: CallPermissionsService;
  inbox: InboxContext;
  logger: Logger;
  registry: CallRegistry;
  tts: Pick<TtsCache, 'get'>;
  storage: StorageProvider | undefined;
  recordingDir: string;
  /** Phase 7 program of an AI call (flow host / AI agent). */
  scriptFor: (call: CallDoc) => Promise<ScriptChoice>;
  tickets?: Pick<WsTicketService, 'issue'>;
  peer?: Omit<PeerOptions, 'role'>;
  clock?: Clock;
  /** Tests: a shorter ring before `not_answered` (default `bicRingTimeoutSec`). */
  bicRingTimeoutSec?: number;
}

export interface CallActor extends AuditActorInput {
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
  impersonatorId?: Types.ObjectId | null;
  ip?: string | null;
}

interface LiveCall {
  callId: string;
  accountId: string;
  waCallId: string | null;
  channel: WhatsAppChannelDoc;
  contactId: Types.ObjectId;
  conversationId: Types.ObjectId;
  mode: 'ai' | 'human';
  peer: WhatsAppPeer;
  leg: WhatsAppCallLeg;
  session: CallSession | null;
  billing: WhatsAppCallBilling;
  bridge: BridgeScript | null;
  agentUserId: Types.ObjectId | null;
  answerApplied: boolean;
  answered: boolean;
  appliedEvents: Set<string>;
  metaDuration: number | null;
  summary: CallEndedSummary | null;
  settleTimer: NodeJS.Timeout | null;
}

const PROVIDER = 'whatsapp' as const;

/** Wallet empty on a human call: the agent gets 30 s, then the call ends (plan §1i). */
const HUMAN_WALLET_GRACE_MS = 30_000;

export const createWhatsAppCalls = (deps: WhatsAppCallsDeps) => {
  const { ctx } = deps;
  const clock = deps.clock ?? systemClock;
  const live = new Map<string, LiveCall>();
  const byWaCall = new Map<string, LiveCall>();

  const capacity = () => ({ active: live.size, max: ctx.env.WA_MEDIA_MAX_CALLS });

  // hangups from any process (POST /calls/:id/hangup) reach the session here
  deps.bus.onHangup(async (callId) => {
    const call = live.get(callId);
    if (!call?.session || call.session.ended) return false;
    await call.session.end('customer_hangup');
    return true;
  });

  const timeline = (callId: string, event: string) =>
    CallModel.updateOne(
      { _id: new Types.ObjectId(callId) },
      { $push: { 'whatsapp.timeline': { event, at: new Date(clock.now()) } } },
    );

  const loadChannel = async (accountId: Types.ObjectId, channelId: string) => {
    const channel = await WhatsAppChannelModel.findOne({
      _id: new Types.ObjectId(channelId),
      accountId,
    }).lean<WhatsAppChannelDoc>();
    if (!channel) throw new NotFoundError('WhatsApp number not found');
    return channel;
  };

  const callingSettings = async (
    accountId: Types.ObjectId,
  ): Promise<AccountWhatsAppCallingSettings & { recordingNotice: string }> => {
    const account = await AccountModel.findById(accountId)
      .select({ 'settings.whatsappCalling': 1, 'settings.recordingNotice': 1 })
      .lean<{
        settings?: {
          whatsappCalling?: Partial<AccountWhatsAppCallingSettings>;
          recordingNotice?: string;
        };
      }>();
    return {
      ...DEFAULT_WHATSAPP_CALLING_SETTINGS,
      recordingNotice:
        account?.settings?.recordingNotice ?? DEFAULT_ACCOUNT_SETTINGS.recordingNotice,
      ...account?.settings?.whatsappCalling,
    };
  };

  const peerOptions = (): PeerOptions => ({
    role: 'business',
    ...(deps.peer ?? {
      bindAddress: '0.0.0.0',
      publicIp: ctx.env.WA_MEDIA_PUBLIC_IP ?? null,
      portRange: [ctx.env.WA_MEDIA_PORT_MIN, ctx.env.WA_MEDIA_PORT_MAX] as [number, number],
      stunUrls: [...ctx.env.WA_STUN_URLS],
    }),
  });

  /** Human calls: a refused extension gives the agent 30 s (warning on the call bar), then ends. */
  const humanBilling = (
    inner: WhatsAppCallBilling,
    call: () => LiveCall | undefined,
  ): CallBillingPort => {
    let graceUntil: number | null = null;
    return {
      get holdId() {
        return inner.holdId;
      },
      needsExtension: (s) => inner.needsExtension(s),
      async extend() {
        if (graceUntil !== null) return clock.now() < graceUntil;
        if (await inner.extend()) return true;
        graceUntil = clock.now() + HUMAN_WALLET_GRACE_MS;
        call()?.bridge?.['agent']?.notify({
          type: 'wallet.empty_warning',
          endsInSec: HUMAN_WALLET_GRACE_MS / 1000,
        });
        return true;
      },
      settle: (usage) => inner.settle(usage),
      release: (reason) => inner.release(reason),
    };
  };

  /* ── after the end: the call charge, the bubble, the permission streak ── */

  const outcomeOf = (s: CallEndedSummary): 'completed' | 'no_answer' | 'rejected' | 'failed' =>
    s.endReason === 'rejected_by_customer'
      ? 'rejected'
      : s.durationSec > 0 || s.status === 'completed'
        ? 'completed'
        : s.endReason === 'not_answered' || s.endReason === 'no_answer'
          ? 'no_answer'
          : 'failed';

  const bubble = async (call: LiveCall, s: CallEndedSummary, answered: boolean) => {
    try {
      const conversation = await ConversationModel.findById(
        call.conversationId,
      ).lean<ConversationDoc>();
      if (!conversation) return;
      const message = await insertMessage(conversation, {
        ...blankContent('call'),
        direction: 'out',
        origin: 'system',
        status: 'sent',
        at: new Date(clock.now()),
        call: {
          callId: new Types.ObjectId(call.callId),
          direction: 'out',
          outcome: answered ? 'completed' : outcomeOf(s),
          durationSec: s.durationSec,
          mode: call.mode,
        },
      });
      emitMessageCreated(message, { replyTo: null });
      const touched = await touchLastMessage(conversation._id, message);
      if (touched) emitConversation(touched);
    } catch (err) {
      deps.logger.warn({ err, callId: call.callId }, 'whatsapp call: bubble failed');
    }
  };

  /** Charges the call part once and writes the price on the call. */
  const settleCharge = async (call: LiveCall, durationSec: number, source: 'meta' | 'ours') => {
    if (call.settleTimer) clearTimeout(call.settleTimer);
    call.settleTimer = null;
    try {
      const settled = await call.billing.settleCallPart(durationSec, source);
      const p = settled.price;
      await CallModel.updateOne(
        { _id: new Types.ObjectId(call.callId) },
        {
          $set: {
            'billing.whatsapp.pulses': p.pulses,
            'billing.whatsapp.metaCostMicros': p.metaCostMicros,
            'billing.whatsapp.markupMicros': p.markupMicros,
            'billing.whatsapp.platformFeeMicros': p.platformFeeMicros,
            'billing.whatsapp.status': call.billing.callHold ? 'settled' : 'free',
            ...(source === 'meta' ? { 'whatsapp.metaDuration': durationSec } : {}),
          },
          $inc: { 'cost.telephonyMicros': p.totalMicros, 'cost.totalMicros': p.totalMicros },
        },
      );
    } catch (err) {
      deps.logger.error({ err, callId: call.callId }, 'whatsapp call: settle failed');
    }
    forget(call);
  };

  const forget = (call: LiveCall) => {
    live.delete(call.callId);
    if (call.waCallId) {
      byWaCall.delete(call.waCallId);
      void deps.bus.release(call.waCallId).catch(() => undefined);
    }
    void deps.bus.releaseCall(call.callId).catch(() => undefined);
  };

  const onEnded = async (call: LiveCall, s: CallEndedSummary) => {
    call.summary = s;
    const answered = call.answered;
    await bubble(call, s, answered);
    await deps.permissions
      .onCallOutcome({
        accountId: new Types.ObjectId(call.accountId),
        channelId: call.channel._id,
        contactId: call.contactId,
        answered,
      })
      .catch((err: unknown) =>
        deps.logger.warn({ err, callId: call.callId }, 'whatsapp call: permission outcome failed'),
      );
    if (!answered) {
      // never connected: the session released the holds, Meta bills nothing
      await CallModel.updateOne(
        { _id: new Types.ObjectId(call.callId) },
        { $set: { 'billing.whatsapp.status': call.billing.callHold ? 'released' : 'free' } },
      );
      forget(call);
      return;
    }
    if (call.metaDuration !== null) {
      await settleCharge(call, call.metaDuration, 'meta');
      return;
    }
    // Meta's terminate (with `duration`) is on its way; else our measured talk time
    call.settleTimer = setTimeout(
      () => void settleCharge(call, s.durationSec, 'ours'),
      LATE_TERMINATE_GRACE_MS,
    );
    call.settleTimer.unref();
  };

  /* ── Meta's events for a call this process owns ── */

  const endReasonOfTerminate = (
    call: LiveCall,
    e: MetaCallEvent,
    errors: unknown[],
  ): CallEndReason =>
    call.answered
      ? 'customer_hangup'
      : e.status === 'FAILED' && errors.length
        ? 'meta_failed'
        : 'not_answered';

  const applyEvent = async (call: LiveCall, eventId: string, value: MetaCallsValue) => {
    if (call.appliedEvents.has(eventId)) return;
    call.appliedEvents.add(eventId);
    for (const e of value.calls ?? []) {
      if (e.id !== call.waCallId) continue;
      if (e.event === 'connect' && e.session?.sdp_type === 'answer' && !call.answerApplied) {
        call.answerApplied = true;
        await call.peer.applyAnswer(e.session.sdp).catch((err: unknown) => {
          deps.logger.warn(
            { errName: (err as Error).name, callId: call.callId },
            'whatsapp call: answer not applied',
          );
        });
        await timeline(call.callId, 'connect');
      }
      if (e.event === 'terminate') {
        const duration = callDurationSec(e);
        call.metaDuration = duration ?? 0;
        const errors = value.errors ?? e.errors ?? [];
        await CallModel.updateOne(
          { _id: new Types.ObjectId(call.callId) },
          {
            $set: {
              'whatsapp.metaStatus': e.status ?? null,
              'whatsapp.metaDuration': duration,
              'whatsapp.metaStartTime': e.start_time ? new Date(Number(e.start_time) * 1000) : null,
              'whatsapp.metaEndTime': e.end_time ? new Date(Number(e.end_time) * 1000) : null,
              'whatsapp.metaErrors': errors.flatMap((x) =>
                typeof x.code === 'number' ? [{ code: x.code }] : [],
              ),
            },
            $push: { 'whatsapp.timeline': { event: 'terminate', at: new Date(clock.now()) } },
          },
        );
        call.leg.endedByMeta();
        if (call.session && !call.session.ended) {
          await call.session.end(endReasonOfTerminate(call, e, errors));
        } else if (call.summary) {
          await settleCharge(call, call.metaDuration, 'meta');
        }
      }
    }
    for (const raw of value.statuses ?? []) {
      const st = raw as { id?: string; status?: string; type?: string };
      if (st.id !== call.waCallId || st.type !== 'call') continue;
      const status = (st.status ?? '').toUpperCase();
      await timeline(call.callId, status.toLowerCase());
      if (status === 'RINGING') call.leg.ringing();
      if (status === 'ACCEPTED' && !call.answered) {
        call.answered = true;
        call.leg.answered();
      }
      if (status === 'REJECTED' && call.session && !call.session.ended) {
        call.leg.endedByMeta();
        await call.session.end('rejected_by_customer');
      }
    }
  };

  /** Loads a stored webhook event (the payload is sealed) → the calls value. */
  const loadEvent = async (eventId: string): Promise<MetaCallsValue | null> => {
    if (!Types.ObjectId.isValid(eventId)) return null;
    const row = await MetaWebhookEventModel.findById(eventId)
      .select('+payloadSealed')
      .lean<{ payloadSealed?: string; field: string }>();
    if (row?.field !== 'calls' || !row.payloadSealed) return null;
    const parsed = callsValueSchema.safeParse(
      JSON.parse(openSecret(ctx, row.payloadSealed)) as unknown,
    );
    return parsed.success ? parsed.data : null;
  };

  const ownerHandler = (call: LiveCall) => async (message: BusMessage) => {
    if (message.type !== 'calls_event') return;
    const value = await loadEvent(message.eventId);
    if (value) await applyEvent(call, message.eventId, value);
  };

  /**
   * The worker's `calls` handler: each call event goes to its owner (the process with
   * the media). Without an owner (it ended / its process died) a terminate is stored
   * on the call for the reconciliation; user-initiated `connect` is T12.7's claim.
   */
  const onWebhook = async (
    _channel: WhatsAppChannelDoc,
    value: unknown,
    event?: { eventId: string },
  ) => {
    const parsed = callsValueSchema.safeParse(value);
    if (!parsed.success || !event) return;
    const ids = new Map<string, string>();
    for (const e of parsed.data.calls ?? []) ids.set(e.id, e.event);
    for (const s of parsed.data.statuses ?? []) {
      const st = s as { id?: string; status?: string };
      if (st.id) ids.set(st.id, (st.status ?? '').toUpperCase());
    }
    for (const [waCallId, kind] of ids) {
      const where = await deps.bus.toOwner(waCallId, {
        type: 'calls_event',
        eventId: event.eventId,
        waCallId,
        kind,
      });
      if (where !== 'no_owner') continue;
      const term = (parsed.data.calls ?? []).find(
        (e) => e.id === waCallId && e.event === 'terminate',
      );
      if (term) {
        await CallModel.updateOne(
          { 'whatsapp.waCallId': waCallId },
          {
            $set: {
              'whatsapp.metaStatus': term.status ?? null,
              'whatsapp.metaDuration': callDurationSec(term),
            },
          },
        );
      }
    }
  };

  /* ── outbound ── */

  const sourceOf = (mode: 'ai' | 'human', program: CallProgram | null): CallSource =>
    mode === 'human' || !program
      ? { kind: null }
      : program.kind === 'flow'
        ? {
            kind: 'flow',
            flowId: new Types.ObjectId(program.id),
            flowVersionRef: 'published' as never,
          }
        : { kind: 'agent', agentId: new Types.ObjectId(program.id) };

  const startOutbound = async (
    actor: CallActor,
    input: {
      channelId: string;
      contactId: string;
      mode: 'ai' | 'human';
      program?: CallProgram | null;
    },
  ) => {
    const now = new Date(clock.now());
    const channel = await loadChannel(actor.accountId, input.channelId);
    const contact = await ContactModel.findOne({
      _id: new Types.ObjectId(input.contactId),
      accountId: actor.accountId,
    }).lean<ContactDoc>();
    const program = input.mode === 'ai' ? (input.program ?? null) : null;
    await assertDial({
      now,
      whatsappEnabled: ctx.env.WHATSAPP_ENABLED,
      channel,
      contact,
      mode: input.mode,
      program,
      impersonating: Boolean(actor.impersonatorId),
      permission: () => deps.permissions.statusFor(actor.accountId, channel._id, input.contactId),
      capacity: capacity(),
      liveCalls: async () => (await deps.registry.liveCalls(actor.accountId.toString())).length,
    });
    if (!contact) throw new NotFoundError('Contact not found');
    const waId = contact.whatsapp?.waId ?? contact.phoneE164.replace(/\D/g, '');
    const conversation =
      (await ConversationModel.findOne({
        accountId: actor.accountId,
        channelId: channel._id,
        waId,
      }).lean<ConversationDoc>()) ??
      (await upsertConversation({
        key: { accountId: actor.accountId, channelId: channel._id, waId },
        contactId: contact._id,
        source: 'outbound',
      }));
    const quote: CallQuote = await quoteCall({
      accountId: actor.accountId,
      phoneE164: contact.phoneE164,
      payer: channel.metaPayer,
      at: now,
    });
    const settings = await callingSettings(actor.accountId);
    const callId = new Types.ObjectId();
    const permissionRow = await deps.permissions.loadRow(actor.accountId, channel._id, contact._id);
    const doc = await CallModel.create({
      _id: callId,
      accountId: actor.accountId,
      direction: 'outbound',
      provider: PROVIDER,
      from: `whatsapp:${channel._id.toString()}`,
      to: contact.phoneE164,
      mode: input.mode,
      source: sourceOf(input.mode, program),
      contactId: contact._id,
      startedBy: actor.userId,
      agentUserId: input.mode === 'human' ? actor.userId : null,
      timestamps: { queuedAt: now },
      whatsapp: {
        channelId: channel._id,
        waCallId: null,
        direction: 'BUSINESS_INITIATED',
        conversationId: conversation._id,
        permissionId: permissionRow?._id ?? null,
        timeline: [{ event: 'queued', at: now }],
      },
      billing: {
        whatsapp: {
          payer: channel.metaPayer,
          market: quote.market,
          perMinuteMicros: quote.perMinuteMicros,
          status: 'held',
        },
      },
    });
    const call: CallDoc = doc.toObject({ transform: false });
    const billing = new WhatsAppCallBilling({
      accountId: actor.accountId.toString(),
      callId: callId.toString(),
      quote,
      charged: true,
      withAi: input.mode === 'ai',
      conversationId: conversation._id.toString(),
    });
    try {
      await billing.hold();
    } catch (err) {
      await CallModel.deleteOne({ _id: callId });
      throw err;
    }
    await CallModel.updateOne(
      { _id: callId },
      { $set: { holdId: billing.holdId ? new Types.ObjectId(billing.holdId) : null } },
    );

    const peer = new WhatsAppPeer(peerOptions());
    // eslint-disable-next-line prefer-const -- assigned below, read by the leg's terminate
    let entry!: LiveCall;
    const leg = new WhatsAppCallLeg({
      peer,
      clock,
      signaling: {
        terminate: async () => {
          if (!entry.waCallId) return;
          const { token } = await deps.token(channel._id);
          await ctx.meta.terminateCall(token, channel.phoneNumberId ?? '', entry.waCallId);
        },
      },
    });
    entry = {
      callId: callId.toString(),
      accountId: actor.accountId.toString(),
      waCallId: null,
      channel,
      contactId: contact._id,
      conversationId: conversation._id,
      mode: input.mode,
      peer,
      leg,
      session: null,
      billing,
      bridge: input.mode === 'human' ? new BridgeScript() : null,
      agentUserId: input.mode === 'human' ? actor.userId : null,
      answerApplied: false,
      answered: false,
      appliedEvents: new Set(),
      metaDuration: null,
      summary: null,
      settleTimer: null,
    };
    live.set(entry.callId, entry);
    await deps.registry.register(
      entry.callId,
      entry.accountId,
      clock.now(),
      CALL_LIMITS.registryTtlSec,
    );
    await deps.bus.ownCall(entry.callId);

    // the program (AI) or the bridge (human); a failing program ends as an engine error
    let choice: ScriptChoice;
    if (entry.bridge) {
      choice = { script: entry.bridge, voice: 'coral', language: 'hinglish' };
    } else {
      choice = await deps.scriptFor(call);
    }
    const session = new CallSession({
      call: { ...call, provider: PROVIDER },
      leg,
      clock,
      logger: deps.logger,
      tts: deps.tts,
      storage: deps.storage,
      registry: deps.registry,
      billing:
        entry.mode === 'human' ? humanBilling(billing, () => live.get(entry.callId)) : billing,
      script: choice.script,
      recordingDir: deps.recordingDir,
      recording: { enabled: settings.recordCalls, notice: settings.recordingNotice },
      voice: choice.voice,
      language: choice.language,
      maxDurationSec: Math.min(
        settings.maxCallMinutes * 60,
        choice.maxDurationSec ?? CALL_LIMITS.maxCallSecHard,
      ),
      answerTimeout: {
        sec: deps.bicRingTimeoutSec ?? WHATSAPP_CALL_LIMITS.bicRingTimeoutSec,
        reason: 'not_answered',
      },
      onEnded: (summary) => void onEnded(entry, summary),
    });
    entry.session = session;

    // Meta: connect with our offer (bizOpaque = our call id)
    let waCallId: string;
    try {
      const offer = await peer.createOffer();
      const { token } = await deps.token(channel._id);
      ({ waCallId } = await ctx.meta.startCall(token, channel.phoneNumberId ?? '', {
        to: waId,
        sdpOffer: offer,
        bizOpaque: entry.callId,
      }));
    } catch (err) {
      const mapped = callError(err);
      const code = mapped instanceof AppError ? mapped.code : 'META_API_ERROR';
      const reason: CallEndReason =
        code === 'WHATSAPP_CALL_PERMISSION_MISSING'
          ? 'permission_missing'
          : code === 'WHATSAPP_CALLING_RESTRICTED'
            ? 'calling_restricted'
            : 'meta_failed';
      await billing.release('connect_failed');
      await CallModel.updateOne(
        { _id: callId },
        {
          $set: {
            status: 'failed',
            endReason: reason,
            'timestamps.endedAt': new Date(clock.now()),
            'billing.whatsapp.status': 'released',
            error: { code },
          },
          $push: { 'whatsapp.timeline': { event: 'connect_failed', at: new Date(clock.now()) } },
        },
      );
      await deps.registry.unregister(entry.callId, entry.accountId).catch(() => undefined);
      await peer.close();
      forget(entry);
      notifyAccount(entry.accountId, 'call.ended', {
        callId: entry.callId,
        provider: PROVIDER,
        status: 'failed',
        endReason: reason,
        durationSec: 0,
        disposition: null,
        costMicros: 0,
      });
      throw mapped;
    }
    entry.waCallId = waCallId;
    byWaCall.set(waCallId, entry);
    await deps.bus.own(waCallId, ownerHandler(entry));
    await CallModel.updateOne(
      { _id: callId },
      {
        $set: { 'whatsapp.waCallId': waCallId },
        $push: { 'whatsapp.timeline': { event: 'dialed', at: new Date(clock.now()) } },
      },
    );
    await session.start();
    notifyAccount(entry.accountId, 'call.created', { callId: entry.callId, isTest: false });
    await recordAudit({
      accountId: actor.accountId,
      actor: {
        type: actor.type,
        id: actor.id ?? actor.userId,
        impersonatorId: actor.impersonatorId ?? null,
      },
      action: 'call.whatsapp_started',
      target: { type: 'call', id: entry.callId },
      meta: {
        channelId: channel._id.toString(),
        direction: 'BUSINESS_INITIATED',
        mode: input.mode,
      },
      ip: actor.ip ?? null,
    });
    const ticket =
      input.mode === 'human'
        ? await issueMediaTicket(
            { userId: actor.userId.toString(), accountId: entry.accountId, callId: entry.callId },
            deps.tickets,
          )
        : null;
    return { callId: entry.callId, ...(ticket ?? {}) };
  };

  /* ── the agent's media socket (via CallManager.attach) ── */

  const attachAgent = (input: MediaAttachInput, leg: CallLeg): Promise<AttachResult> => {
    const call = live.get(input.callId);
    if (!call?.bridge || !call.session || call.session.ended) {
      return Promise.resolve({ ok: false, code: MEDIA_CLOSE.callEnded, reason: 'call ended' });
    }
    if (call.agentUserId?.toString() !== input.userId || call.accountId !== input.accountId) {
      return Promise.resolve({ ok: false, code: MEDIA_CLOSE.forbidden, reason: 'not your call' });
    }
    if (call.bridge.hasAgent) {
      return Promise.resolve({
        ok: false,
        code: MEDIA_CLOSE.callEnded,
        reason: 'already attached',
      });
    }
    call.bridge.attachAgent(leg);
    return Promise.resolve({ ok: true });
  };

  const setHold = async (accountId: Types.ObjectId, callId: string, on: boolean) => {
    const call = live.get(callId);
    if (call?.accountId !== accountId.toString() || !call.bridge || call.session?.ended) {
      throw new AppError('CALL_NOT_ACTIVE');
    }
    await call.bridge.setHold(on);
    await timeline(callId, on ? 'hold' : 'unhold');
    return { onHold: call.bridge.onHold };
  };

  /** Shutdown: every live call ends politely (Phase 7 line), then Meta terminate. */
  const shutdown = async () => {
    await Promise.all(
      [...live.values()].map((c) =>
        c.session && !c.session.ended
          ? c.session.politeEnd(CALL_LINES.technical, 'server_shutdown').catch(() => undefined)
          : Promise.resolve(),
      ),
    );
    for (const c of live.values()) if (c.settleTimer) clearTimeout(c.settleTimer);
  };

  return {
    startOutbound,
    attachAgent,
    setHold,
    onWebhook,
    applyEvent,
    shutdown,
    /** Tests / dev: the live call of this process. */
    liveCall: (callId: string) => live.get(callId) ?? null,
    get load() {
      return live.size;
    },
  };
};

export type WhatsAppCallsService = ReturnType<typeof createWhatsAppCalls>;
