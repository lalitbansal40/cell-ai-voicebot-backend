import { Types } from 'mongoose';

import { CALL_LIMITS, CALL_LINES, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import {
  callDurationSec,
  callsValueSchema,
  type MetaCallEvent,
  type MetaCallsValue,
} from '../../core/meta';
import { notifyAccount, notifyUser } from '../../core/realtime/notify';
import { onlineUsers } from '../../core/realtime/presence';
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
import { UserModel } from '../../db/models/user.model';
import {
  defaultCalling,
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
import { findOrCreateWhatsAppContact } from '../inbox/contacts';
import type { InboxContext } from '../inbox/context';
import { touchLastMessage, upsertConversation } from '../inbox/conversation-store';
import { emitConversation, emitMessageCreated } from '../inbox/events';
import { blankContent, insertMessage } from '../inbox/message-store';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import { openSecret } from '../whatsapp/context';

import { activeRestrictions } from './availability';
import { LATE_TERMINATE_GRACE_MS, quoteCall, WhatsAppCallBilling, type CallQuote } from './billing';
import { BridgeScript } from './bridge';
import type { BusMessage, CallCommand, CallControlBus } from './bus';
import { assertDial } from './dial-guard';
import { callError } from './errors';
import { HandoffScript } from './handoff';
import type { CallPermissionsService } from './permissions.service';
import type { CallProgram } from './program';
import { selectRingTargets, withinCallHours } from './routing';
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
  /** Shared WS presence in production; injectable for loopback integration tests. */
  onlineUsers?: (accountId: string) => Promise<string[]>;
}

export interface CallActor extends AuditActorInput {
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
  impersonatorId?: Types.ObjectId | null;
  ip?: string | null;
}

interface LiveCall {
  direction: 'in' | 'out';
  callId: string;
  accountId: string;
  waCallId: string | null;
  channel: WhatsAppChannelDoc;
  contactId: Types.ObjectId;
  conversationId: Types.ObjectId;
  mode: 'ai' | 'human';
  /** The AI program kind: an agent hears the "no one free" line after a failed transfer. */
  programKind: 'flow' | 'agent' | null;
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
  settlement?: Promise<void>;
  endTask?: Promise<void>;
  answerSdp: string | null;
  terminated: boolean;
  handoff: HandoffScript | null;
  ring: Ring | null;
}

interface Ring {
  id: string;
  targets: string[];
  until: number;
  winner: string | null;
  timer: unknown;
  transfer: boolean;
  resolve: (connected: boolean) => void;
}

const PROVIDER = 'whatsapp' as const;

const ringAction = (command: CallCommand): boolean =>
  command.action === 'answer' || command.action === 'decline';

/** An agent program resumes with this after nobody took the transfer (a flow uses its failure exit). */
export const NO_AGENT_LINE =
  'Abhi koi team member free nahi hai. Main aapki madad karti hoon. / No team member is free right now, I will help you.';

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
      bindAddress: ctx.meta.provider === 'fake' ? '127.0.0.1' : '0.0.0.0',
      publicIp: ctx.env.WA_MEDIA_PUBLIC_IP ?? null,
      portRange: [ctx.env.WA_MEDIA_PORT_MIN, ctx.env.WA_MEDIA_PORT_MAX] as [number, number],
      stunUrls: ctx.meta.provider === 'fake' ? [] : [...ctx.env.WA_STUN_URLS],
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
        direction: call.direction,
        origin: 'system',
        status: 'sent',
        at: new Date(clock.now()),
        call: {
          callId: new Types.ObjectId(call.callId),
          direction: call.direction,
          outcome: answered ? 'completed' : call.direction === 'in' ? 'missed' : outcomeOf(s),
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
  const settleCharge = (
    call: LiveCall,
    durationSec: number,
    source: 'meta' | 'ours',
  ): Promise<void> => {
    call.settlement ??= performSettlement(call, durationSec, source);
    return call.settlement;
  };
  const performSettlement = async (
    call: LiveCall,
    durationSec: number,
    source: 'meta' | 'ours',
  ) => {
    if (call.settleTimer) clearTimeout(call.settleTimer);
    call.settleTimer = null;
    try {
      const settled = await call.billing.settleCallPart(durationSec, source);
      const p = settled.price;
      await CallModel.updateOne(
        {
          _id: new Types.ObjectId(call.callId),
          'billing.whatsapp.status': { $nin: ['settled', 'released'] },
        },
        {
          $set: {
            'billing.whatsapp.pulses': p.pulses,
            'billing.whatsapp.metaCostMicros': p.metaCostMicros,
            'billing.whatsapp.markupMicros': p.markupMicros,
            'billing.whatsapp.platformFeeMicros': p.platformFeeMicros,
            'billing.whatsapp.status': call.billing.callHold ? 'settled' : 'free',
            'billing.whatsapp.durationSource': source,
            ...(source === 'meta' ? { 'whatsapp.metaDuration': durationSec } : {}),
          },
          $inc: { 'cost.telephonyMicros': p.totalMicros, 'cost.totalMicros': p.totalMicros },
        },
      );
    } catch (err) {
      deps.logger.error({ err, callId: call.callId }, 'whatsapp call: settle failed');
      delete call.settlement;
      return;
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
    await CallModel.updateOne(
      { _id: new Types.ObjectId(call.callId) },
      { $set: { 'metrics.whatsapp': call.leg.metrics } },
    ).catch((err: unknown) => {
      deps.logger.warn({ err, callId: call.callId }, 'whatsapp call: metrics save failed');
    });
    if (call.agentUserId)
      await deps.bus.releaseAgent(call.accountId, call.agentUserId.toString(), call.callId);
    if (call.ring) finishRing(call, false, 'ended');
    const answered = call.answered;
    await bubble(call, s, answered);
    if (call.direction === 'in' && !answered) {
      const row = await CallModel.findById(call.callId)
        .select({ 'whatsapp.ringUserIds': 1 })
        .lean<CallDoc>();
      const rang = row?.whatsapp?.ringUserIds ?? [];
      // nobody was online to ring: everyone who could have answered (the number's ring
      // list when it has one) still hears about the missed customer
      const listed = (call.channel.calling ?? defaultCalling()).inbound.ringUserIds?.map(String);
      const ids = rang.length
        ? rang
        : (await usersWithPermission(new Types.ObjectId(call.accountId), 'calls.answer'))
            .map((u) => u.userId)
            .filter((id) => !listed || listed.includes(id.toString()));
      if (ids.length)
        await notify({
          accountId: new Types.ObjectId(call.accountId),
          userIds: ids,
          type: 'call.whatsapp_missed',
          title: 'Missed WhatsApp call',
          body: 'A customer called while no team member answered.',
          link: `/inbox/${call.conversationId.toString()}`,
        });
    }
    if (call.direction === 'out')
      await deps.permissions
        .onCallOutcome({
          accountId: new Types.ObjectId(call.accountId),
          channelId: call.channel._id,
          contactId: call.contactId,
          answered,
        })
        .catch((err: unknown) =>
          deps.logger.warn(
            { err, callId: call.callId },
            'whatsapp call: permission outcome failed',
          ),
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
        call.terminated = true;
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
      if (
        status === 'ACCEPTED' &&
        !call.answered &&
        !call.terminated &&
        !call.session?.ended &&
        call.direction === 'out'
      ) {
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
        await ctx.redis.set(
          `call:wa:ended:${waCallId}`,
          '1',
          'EX',
          WHATSAPP_CALL_LIMITS.claimTtlSec,
        );
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
      const incoming = (parsed.data.calls ?? []).find(
        (e) => e.id === waCallId && e.event === 'connect' && e.direction === 'USER_INITIATED',
      );
      if (incoming) await startInbound(_channel, incoming, parsed.data);
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
      ignoreWindow: ctx.env.WA_CALL_WINDOW_IGNORED,
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
    if (
      input.mode === 'human' &&
      !(await deps.bus.claimAgent(
        actor.accountId.toString(),
        actor.userId.toString(),
        callId.toString(),
      ))
    )
      throw new AppError('CALL_AGENT_UNAVAILABLE');
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
      if (input.mode === 'human')
        await deps.bus.releaseAgent(
          actor.accountId.toString(),
          actor.userId.toString(),
          callId.toString(),
        );
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
        transfer: () => transferToTeam(entry),
      },
    });
    entry = {
      direction: 'out',
      callId: callId.toString(),
      accountId: actor.accountId.toString(),
      waCallId: null,
      channel,
      contactId: contact._id,
      conversationId: conversation._id,
      mode: input.mode,
      programKind: input.mode === 'ai' ? (program?.kind ?? null) : null,
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
      answerSdp: null,
      terminated: false,
      handoff: null,
      ring: null,
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
      try {
        choice = await deps.scriptFor(call);
      } catch (err) {
        await billing.release('engine_error');
        await peer.close();
        await deps.registry.unregister(entry.callId, entry.accountId);
        await CallModel.updateOne(
          { _id: callId },
          {
            $set: {
              status: 'failed',
              endReason: 'engine_error',
              'timestamps.endedAt': new Date(clock.now()),
              'billing.whatsapp.status': 'released',
            },
          },
        );
        forget(entry);
        throw err;
      }
      entry.handoff = new HandoffScript(choice.script);
      choice = { ...choice, script: entry.handoff };
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
      onEnded: (summary) => {
        entry.endTask = onEnded(entry, summary).catch((err: unknown) => {
          deps.logger.error(
            { errName: (err as Error).name, callId: entry.callId },
            'whatsapp call: completion failed',
          );
        });
      },
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
      if (input.mode === 'human')
        await deps.bus.releaseAgent(entry.accountId, actor.userId.toString(), entry.callId);
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

  /* ── inbound calls and team handoff ── */

  const targetsFor = async (call: LiveCall): Promise<string[]> => {
    const accountId = new Types.ObjectId(call.accountId);
    const eligible = await usersWithPermission(accountId, 'calls.answer');
    const available = await UserModel.find({
      accountId,
      status: 'active',
      callAvailability: 'available',
    })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }[]>();
    const busy = await CallModel.find({
      accountId,
      status: { $in: ['queued', 'ringing', 'in_progress'] },
      agentUserId: { $ne: null },
    })
      .select({ agentUserId: 1 })
      .lean<CallDoc[]>();
    const occupied = new Set(busy.map((c) => c.agentUserId?.toString()));
    return selectRingTargets({
      eligible: eligible.map((u) => u.userId.toString()),
      available: available.map((u) => u._id.toString()).filter((id) => !occupied.has(id)),
      online: await (deps.onlineUsers?.(call.accountId) ?? onlineUsers(ctx.redis, call.accountId)),
      ringUserIds:
        (call.channel.calling ?? defaultCalling()).inbound.ringUserIds?.map(String) ?? null,
    });
  };

  const finishRing = (call: LiveCall, connected: boolean, reason: string): void => {
    const ring = call.ring;
    if (!ring) return;
    call.ring = null;
    clock.clearTimeout(ring.timer);
    for (const userId of ring.targets)
      notifyUser(call.accountId, userId, 'whatsapp.call.ended_ringing', {
        callId: call.callId,
        reason,
      });
    ring.resolve(connected);
  };

  const rejectInbound = async (call: LiveCall, reason: CallEndReason): Promise<void> => {
    if (call.session?.ended) return;
    call.leg.endedByMeta();
    await call.session?.end(reason);
    const { token } = await deps.token(call.channel._id);
    if (call.waCallId && !call.terminated)
      await ctx.meta
        .rejectCall(token, call.channel.phoneNumberId ?? '', call.waCallId)
        .catch(() => undefined);
  };

  const ringTeam = async (
    call: LiveCall,
    transfer: boolean,
    only?: string,
    ready?: (ok: boolean) => void,
  ): Promise<boolean> => {
    if (call.session?.ended || call.terminated || call.ring) {
      ready?.(false);
      return false;
    }
    const targets = (await targetsFor(call)).filter((id) => !only || id === only);
    if (!targets.length) {
      ready?.(false);
      return false;
    }
    const sec = Math.min(
      (call.channel.calling ?? defaultCalling()).inbound.ringTimeoutSec,
      WHATSAPP_CALL_LIMITS.uicRingTimeoutSec,
    );
    const until = clock.now() + sec * 1000;
    let resolve!: (ok: boolean) => void;
    const result = new Promise<boolean>((r) => {
      resolve = r;
    });
    call.ring = {
      id: `${call.callId}-${String(clock.now())}`,
      targets,
      until,
      winner: null,
      transfer,
      resolve,
      timer: clock.setTimeout(() => finishRing(call, false, 'timeout'), sec * 1000),
    };
    await CallModel.updateOne(
      { _id: call.callId },
      { $set: { 'whatsapp.ringUserIds': targets.map((id) => new Types.ObjectId(id)) } },
    );
    for (const userId of targets)
      notifyUser(call.accountId, userId, 'whatsapp.call.incoming', {
        callId: call.callId,
        conversationId: call.conversationId.toString(),
        contactId: call.contactId.toString(),
        channelId: call.channel._id.toString(),
        ringUntil: new Date(until).toISOString(),
      });
    ready?.(true);
    if (transfer) {
      call.leg.clearAudio();
      // The provider's transfer awaits this promise; its failure resumes the AI program.
      void deps.tts
        .get({
          text: 'Kripya line par bane rahein. / Please stay on the line.',
          voice: 'coral',
          language: 'hinglish',
        })
        .then(({ pcm }) => call.leg.play(pcm))
        .catch(() => undefined);
    }
    return result;
  };

  /** The AI program's transfer: ring the team with the hold clip; nobody → back to the AI. */
  const transferToTeam = async (call: LiveCall): Promise<'connected' | 'failed'> => {
    if (await ringTeam(call, true)) return 'connected';
    if (call.programKind === 'agent' && !call.session?.ended && !call.terminated) {
      call.leg.clearAudio();
      await deps.tts
        .get({ text: NO_AGENT_LINE, voice: 'coral', language: 'hinglish' })
        .then(({ pcm }) => call.leg.play(pcm))
        .catch(() => undefined);
    }
    return 'failed';
  };

  const acceptInbound = async (call: LiveCall): Promise<void> => {
    if (
      call.answered ||
      call.session?.ended ||
      call.terminated ||
      !call.answerSdp ||
      !call.waCallId
    )
      return;
    const { token } = await deps.token(call.channel._id);
    await ctx.meta.acceptCall(
      token,
      call.channel.phoneNumberId ?? '',
      call.waCallId,
      call.answerSdp,
      call.callId,
    );
    if (call.terminated || call.session?.ended) return;
    call.answered = true;
    call.leg.answered();
    await timeline(call.callId, 'accepted');
  };

  const startInbound = async (
    channel: WhatsAppChannelDoc,
    event: MetaCallEvent,
    value: MetaCallsValue,
  ): Promise<void> => {
    if (!event.session || event.session.sdp_type !== 'offer' || capacity().active >= capacity().max)
      return;
    if (await ctx.redis.exists(`call:wa:ended:${event.id}`)) return;
    if (!(await deps.bus.claimInbound(event.id))) return;
    const calling = channel.calling ?? defaultCalling();
    const phone = event.from?.replace(/\D/g, '') ?? '';
    const bsuid = event.from_user_id ?? null;
    let contact = phone
      ? await findOrCreateWhatsAppContact({
          accountId: channel.accountId,
          waId: phone,
          profileName: value.contacts?.[0]?.profile?.name,
        })
      : null;
    if (!contact && bsuid)
      contact = await ContactModel.findOne({
        accountId: channel.accountId,
        'whatsapp.bsuid': bsuid,
        deletedAt: null,
      }).lean<ContactDoc>();
    if (!contact) {
      // An unidentified offer must never create a fabricated phone number.
      const { token } = await deps.token(channel._id);
      await ctx.meta.rejectCall(token, channel.phoneNumberId ?? '', event.id);
      return;
    }
    if (bsuid)
      await ContactModel.updateOne({ _id: contact._id }, { $set: { 'whatsapp.bsuid': bsuid } });
    const identity =
      phone || bsuid || contact.whatsapp?.waId || contact.phoneE164.replace(/\D/g, '');
    const conversation = await upsertConversation({
      key: { accountId: channel.accountId, channelId: channel._id, waId: identity },
      contactId: contact._id,
      source: 'inbound',
    });
    const settings = await callingSettings(channel.accountId);
    const route = calling.inbound.route;
    const mode = route === 'team' ? 'human' : 'ai';
    const quote = await quoteCall({
      accountId: channel.accountId,
      phoneE164: contact.phoneE164,
      payer: channel.metaPayer,
      at: new Date(clock.now()),
    });
    const created = await CallModel.create({
      accountId: channel.accountId,
      provider: PROVIDER,
      direction: 'inbound',
      mode,
      from: contact.phoneE164,
      to: `whatsapp:${channel._id.toString()}`,
      contactId: contact._id,
      source: sourceOf(
        mode,
        calling.inbound.aiProgram
          ? { kind: calling.inbound.aiProgram.kind, id: calling.inbound.aiProgram.id.toString() }
          : null,
      ),
      timestamps: { queuedAt: new Date(clock.now()) },
      whatsapp: {
        channelId: channel._id,
        waCallId: event.id,
        direction: 'USER_INITIATED',
        conversationId: conversation._id,
        ctaPayload: event.cta_payload ?? null,
        deeplinkPayload: event.deeplink_payload ?? null,
        timeline: [{ event: 'connect', at: new Date(clock.now()) }],
      },
      billing: {
        whatsapp: {
          payer: channel.metaPayer,
          market: quote.market,
          perMinuteMicros: quote.perMinuteMicros,
          status: 'free',
        },
      },
    });
    const doc: CallDoc = created.toObject({ transform: false });
    const billing = new WhatsAppCallBilling({
      accountId: channel.accountId.toString(),
      callId: doc._id.toString(),
      quote,
      charged: false,
      withAi: mode === 'ai',
      conversationId: conversation._id.toString(),
    });
    const peer = new WhatsAppPeer(peerOptions());
    const call: LiveCall = {
      direction: 'in',
      callId: doc._id.toString(),
      accountId: channel.accountId.toString(),
      waCallId: event.id,
      channel,
      contactId: contact._id,
      conversationId: conversation._id,
      mode,
      programKind: mode === 'ai' ? (calling.inbound.aiProgram?.kind ?? null) : null,
      peer,
      leg: new WhatsAppCallLeg({
        peer,
        clock,
        waitForAnswer: true,
        signaling: {
          terminate: async () => {
            const { token } = await deps.token(channel._id);
            await ctx.meta.terminateCall(token, channel.phoneNumberId ?? '', event.id);
          },
          transfer: () => transferToTeam(call),
        },
      }),
      session: null,
      billing,
      bridge: mode === 'human' ? new BridgeScript() : null,
      agentUserId: null,
      answerApplied: true,
      answered: false,
      appliedEvents: new Set(),
      metaDuration: null,
      summary: null,
      settleTimer: null,
      answerSdp: null,
      terminated: false,
      handoff: null,
      ring: null,
    };
    live.set(call.callId, call);
    byWaCall.set(event.id, call);
    await deps.bus.ownCall(call.callId);
    await deps.bus.own(event.id, ownerHandler(call));
    await deps.registry.register(
      call.callId,
      call.accountId,
      clock.now(),
      WHATSAPP_CALL_LIMITS.uicRingTimeoutSec + CALL_LIMITS.readyTimeoutSec,
    );
    const account = await AccountModel.findById(channel.accountId)
      .select({ status: 1 })
      .lean<{ status: string }>();
    let refusal: CallEndReason | null =
      account?.status !== 'active' ||
      calling.status !== 'enabled' ||
      activeRestrictions(calling, 'user', new Date(clock.now())).length
        ? 'calling_restricted'
        : !withinCallHours(calling.callHours, new Date(clock.now()))
          ? 'outside_call_hours'
          : null;
    let choice: ScriptChoice = {
      script: call.bridge ?? new BridgeScript(),
      voice: 'coral',
      language: 'hinglish',
    };
    try {
      if (!refusal) await billing.hold();
      if (!refusal && mode === 'ai') {
        choice = await deps.scriptFor(doc);
        call.handoff = new HandoffScript(choice.script);
        choice = { ...choice, script: call.handoff };
      }
    } catch (err) {
      refusal =
        err instanceof AppError && err.code === 'WALLET_INSUFFICIENT_BALANCE'
          ? 'wallet_empty'
          : 'engine_error';
    }
    call.session = new CallSession({
      call: doc,
      leg: call.leg,
      clock,
      logger: deps.logger,
      tts: deps.tts,
      storage: deps.storage,
      registry: deps.registry,
      billing,
      script: choice.script,
      recordingDir: deps.recordingDir,
      recording: { enabled: settings.recordCalls, notice: settings.recordingNotice },
      voice: choice.voice,
      language: choice.language,
      maxDurationSec: Math.min(
        settings.maxCallMinutes * 60,
        choice.maxDurationSec ?? CALL_LIMITS.maxCallSecHard,
      ),
      answerTimeout: { sec: calling.inbound.ringTimeoutSec, reason: 'no_agent_available' },
      onEnded: (summary) => {
        call.endTask = onEnded(call, summary).catch((err: unknown) => {
          deps.logger.error(
            { errName: (err as Error).name, callId: call.callId },
            'whatsapp call: completion failed',
          );
        });
      },
    });
    await call.session.start();
    notifyAccount(call.accountId, 'call.created', { callId: call.callId, isTest: false });
    try {
      if (refusal || call.terminated || (await ctx.redis.exists(`call:wa:ended:${event.id}`))) {
        await rejectInbound(call, refusal ?? 'customer_hangup');
        return;
      }
      call.answerSdp = await peer.answer(event.session.sdp);
      const { token } = await deps.token(channel._id);
      if (call.terminated || call.session.ended) return;
      await ctx.meta.preAcceptCall(token, channel.phoneNumberId ?? '', event.id, call.answerSdp);
      if (call.terminated || call.session.ended) return;
      if (mode === 'ai') await acceptInbound(call);
      else
        void ringTeam(call, false)
          .then(async (connected) => {
            if (!connected) await rejectInbound(call, 'no_agent_available');
          })
          .catch(() => rejectInbound(call, 'engine_error'));
    } catch {
      await rejectInbound(call, 'meta_failed');
    }
  };

  const ticketFor = (call: LiveCall, userId: string) =>
    issueMediaTicket({ callId: call.callId, accountId: call.accountId, userId }, deps.tickets);

  const handleCommand = async (command: CallCommand): Promise<unknown> => {
    const call = live.get(command.callId);
    if (call && call.accountId !== command.accountId) throw new NotFoundError('Call not found');
    if (!call)
      throw new AppError(ringAction(command) ? 'WHATSAPP_CALL_NOT_RINGING' : 'CALL_NOT_ACTIVE');
    if (call.session?.ended || call.terminated) throw new AppError('WHATSAPP_CALL_NOT_RINGING');
    if (command.action === 'hold') {
      if (call.agentUserId?.toString() !== command.userId) throw new AppError('AUTH_FORBIDDEN');
      return setHold(new Types.ObjectId(command.accountId), command.callId, command.on === true);
    }
    if (command.action === 'media_ticket') {
      if (call.agentUserId?.toString() !== command.userId) throw new AppError('AUTH_FORBIDDEN');
      return { callId: call.callId, ...(await ticketFor(call, command.userId)) };
    }
    if (command.action === 'transfer') {
      if (call.mode !== 'ai' || !call.handoff || call.ring)
        throw new AppError('CONFLICT_INVALID_STATE');
      const target = command.targetUserId ?? command.userId;
      const ready = await new Promise<boolean>((resolve) => {
        void ringTeam(call, true, target, resolve).catch(() => resolve(false));
      });
      if (!ready) throw new AppError('CALL_AGENT_UNAVAILABLE');
      return { callId: call.callId, ringing: true };
    }
    const ring = call.ring;
    if (!ring || ring.until <= clock.now()) throw new AppError('WHATSAPP_CALL_NOT_RINGING');
    if (!ring.targets.includes(command.userId)) throw new AppError('AUTH_FORBIDDEN');
    if (command.action === 'decline') {
      if (ring.winner) throw new AppError('WHATSAPP_CALL_TAKEN');
      ring.targets = ring.targets.filter((id) => id !== command.userId);
      if (!ring.targets.length) finishRing(call, false, 'declined');
      return { declined: true };
    }
    const eligible = await targetsFor(call);
    if (!eligible.includes(command.userId)) throw new AppError('CALL_AGENT_UNAVAILABLE');
    if (!(await deps.bus.claimAgent(call.accountId, command.userId, call.callId)))
      throw new AppError('CALL_AGENT_UNAVAILABLE');
    const winner = await deps.bus.claimAnswer(ring.id, command.userId);
    if (winner !== command.userId || ring.winner) {
      if (winner !== command.userId)
        await deps.bus.releaseAgent(call.accountId, command.userId, call.callId);
      throw new AppError('WHATSAPP_CALL_TAKEN');
    }
    if (call.ring !== ring || call.session?.ended || call.terminated || ring.until <= clock.now())
      throw new AppError('WHATSAPP_CALL_NOT_RINGING');
    ring.winner = winner;
    call.agentUserId = new Types.ObjectId(winner);
    call.bridge ??= new BridgeScript();
    await CallModel.updateOne(
      { _id: call.callId },
      {
        $set: {
          agentUserId: call.agentUserId,
          [ring.transfer ? 'whatsapp.transferredTo' : 'whatsapp.answeredBy']: call.agentUserId,
        },
      },
    );
    for (const userId of ring.targets)
      if (userId !== winner)
        notifyUser(call.accountId, userId, 'whatsapp.call.taken', {
          callId: call.callId,
          byUserId: winner,
        });
    return { callId: call.callId, ...(await ticketFor(call, winner)) };
  };
  deps.bus.onCommand(handleCommand);
  const unlistenInbound = deps.bus.onInbound(async (message) => {
    if (message.type !== 'calls_event') return;
    const value = await loadEvent(message.eventId);
    if (!value) return;
    const channel = await WhatsAppChannelModel.findOne({
      phoneNumberId: value.metadata.phone_number_id,
    }).lean<WhatsAppChannelDoc>();
    if (channel) await onWebhook(channel, value, { eventId: message.eventId });
  });

  /* ── the agent's media socket (via CallManager.attach) ── */

  const attachAgent = async (input: MediaAttachInput, leg: CallLeg): Promise<AttachResult> => {
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
    if (call.direction === 'in' && !call.answered) await acceptInbound(call);
    const transferring = call.ring?.transfer;
    finishRing(call, true, 'answered');
    if (transferring && call.handoff) {
      call.leg.clearAudio();
      await call.handoff.takeOver(call.bridge);
      call.mode = 'human';
      await CallModel.updateOne({ _id: call.callId }, { $set: { mode: 'human' } });
      await recordAudit({
        accountId: new Types.ObjectId(call.accountId),
        actor: { type: 'user', id: call.agentUserId },
        action: 'call.whatsapp_transferred',
        target: { type: 'call', id: call.callId },
      });
    } else if (call.direction === 'in') {
      await recordAudit({
        accountId: new Types.ObjectId(call.accountId),
        actor: { type: 'user', id: call.agentUserId },
        action: 'call.whatsapp_answered',
        target: { type: 'call', id: call.callId },
      });
    }
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
    unlistenInbound();
    await Promise.all(
      [...live.values()].map((c) =>
        c.session && !c.session.ended
          ? c.session.politeEnd(CALL_LINES.technical, 'server_shutdown').catch(() => undefined)
          : Promise.resolve(),
      ),
    );
    const ending = [...live.values()];
    await Promise.all(ending.map((c) => c.endTask ?? Promise.resolve()));
    await Promise.all(
      ending.map(async (c) => {
        if (c.summary && c.answered)
          await settleCharge(
            c,
            c.metaDuration ?? c.summary.durationSec,
            c.metaDuration === null ? 'ours' : 'meta',
          );
        if (c.settleTimer) clearTimeout(c.settleTimer);
      }),
    );
  };

  return {
    startOutbound,
    attachAgent,
    setHold,
    /** Agent actions on the media owner; answer / decline on a call no one owns is not ringing. */
    command: async (command: CallCommand): Promise<unknown> => {
      try {
        return await deps.bus.command(command);
      } catch (err) {
        if (ringAction(command) && err instanceof AppError && err.code === 'CALL_NOT_ACTIVE')
          throw new AppError('WHATSAPP_CALL_NOT_RINGING');
        throw err;
      }
    },
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
