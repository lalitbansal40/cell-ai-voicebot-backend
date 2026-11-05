import type { Redis } from 'ioredis';
import { Types } from 'mongoose';

import { CALL_LIMITS } from '../../../config/limits';
import { notifyUser } from '../../../core/realtime/notify';
import { onlineUsers } from '../../../core/realtime/presence';
import type { WsTicketService } from '../../../core/realtime/ws-tickets';
import type { AttachResult, MediaAttachInput } from '../../../core/telephony/media-server';
import { MEDIA_CLOSE } from '../../../core/telephony/media-server';
import type { InboundReject, SipCallLeg } from '../../../core/telephony/sip/leg';
import {
  SipLineBusyError,
  SipNoMediaPortError,
  type IncomingSipCall,
} from '../../../core/telephony/sip/provider';
import type { CallLeg, TransferResult } from '../../../core/telephony/types';
import { systemClock, type Clock } from '../../../core/voice/clock';
import { isDuplicateKeyError } from '../../../db/errors';
import { AccountModel, type AccountVoiceLine } from '../../../db/models/account.model';
import {
  CallModel,
  type CallDoc,
  type CallEndReason,
  type CallSource,
  type CallStatus,
  type MissedReason,
} from '../../../db/models/call.model';
import { ContactModel, type ContactDoc } from '../../../db/models/contact.model';
import { DndEntryModel } from '../../../db/models/dnd-entry.model';
import {
  INBOUND_PURPOSES,
  PhoneNumberModel,
  type PhoneNumberDoc,
} from '../../../db/models/phone-number.model';
import { UserModel } from '../../../db/models/user.model';
import { AppError, NotFoundError } from '../../../shared/errors/app-error';
import type { Logger } from '../../../shared/logger';
import { maskPhone } from '../../../shared/utils/mask';
import { buildSearchText } from '../../contacts/normalize/search-text';
import { notify, usersWithPermission } from '../../notifications/notifications.service';
import { publishCallMissed } from '../../webhooks/publish';
import { BridgeScript } from '../../whatsapp-calling/bridge';
import type { CallCommand, CallControlBus } from '../../whatsapp-calling/bus';
import { HandoffScript } from '../../whatsapp-calling/handoff';
import { selectRingTargets, withinCallHours } from '../../whatsapp-calling/routing';
import { CallBilling, type CallBillingPort } from '../billing';
import type { CallManager } from '../call.service';
import { effectiveLine } from '../line';
import { issueMediaTicket } from '../media-tickets';
import type { CallScript } from '../session';

import { normalizeCaller, normalizeDid } from './numbers';
import { FreeBilling, MessageScript, TeamScript, type RingOutcome } from './scripts';

/**
 * Incoming phone calls (Phase 20, ADR 0051): a trunk call that reached this process's
 * inbound ARI app → the account of the dialed number → checks (spam, line, hours,
 * wallet) → call doc → the number's route: AI program, the team in the browser, or both.
 * Calls nobody took become missed calls (bell, webhook, callback list).
 */

export const WALLET_LOW_LINE =
  'Maaf kijiye, yeh seva abhi uplabdh nahi hai. Kripya baad mein call karein. / Sorry, this service is not available right now.';
export const NO_AGENT_LINE =
  'Abhi hamari team ka koi sadasya uplabdh nahi hai. Hum aapko jald call back karenge. Dhanyavaad.';

const CLAIM_TTL_SEC = 300;

type Line = {
  acceptInbound(input: { callId: string; channelId: string; did: string }): Promise<SipCallLeg>;
  rejectInbound(channelId: string, reason: InboundReject): Promise<void>;
};

export interface InboundSipDeps {
  line: Line;
  manager: CallManager;
  bus: CallControlBus;
  redis: Redis;
  /** Redis key prefix (tests). */
  prefix?: string;
  logger: Logger;
  clock?: Clock;
  env: {
    TELEPHONY_PROVIDER: 'dryrun' | 'sip';
    SIP_INBOUND_PER_CALLER_PER_HOUR: number;
    SIP_INBOUND_RING_MAX_SEC: number;
  };
  tickets?: Pick<WsTicketService, 'issue'>;
  /** Online team members of an account (default: realtime presence in Redis). */
  onlineUsers?: (accountId: string) => Promise<string[]>;
  /** Fixed lines (tests use short ones; the paced line plays them in real time). */
  lines?: { walletLow?: string; noAgent?: string };
}

interface Ring {
  id: string;
  targets: string[];
  until: number;
  winner: string | null;
  transfer: boolean;
  timer: unknown;
  resolve: (outcome: RingOutcome) => void;
}

interface LiveInbound {
  callId: string;
  accountId: string;
  number: PhoneNumberDoc;
  contact: ContactDoc | null;
  leg: SipCallLeg;
  bridge: BridgeScript;
  handoff: HandoffScript | null;
  ring: Ring | null;
  rang: Set<string>;
  agentUserId: string | null;
  answered: boolean;
  /** A person or the AI took the call: it is not missed. */
  taken: boolean;
  /** Set before the call runs (after hours / wallet low) — always a missed call. */
  presetMissed: MissedReason | null;
  /** Why the last ring ended without a person. */
  ringMiss: MissedReason | null;
  /** The caller hung up while the team was ringing. */
  callerLeft: boolean;
}

interface CallerCtx {
  channelId: string;
  number: PhoneNumberDoc;
  accountId: Types.ObjectId;
  caller: string | null;
}

const programSource = (number: PhoneNumberDoc): CallSource | null => {
  const p = number.inbound.program;
  if (!p) return null;
  return p.kind === 'flow' ? { kind: 'flow', flowId: p.id } : { kind: 'agent', agentId: p.id };
};

/** Flow calls run the published version (no `flowVersionRef` on the call doc). */
const flowSource = (source: CallSource): CallSource => source;

export const createInboundSip = (deps: InboundSipDeps) => {
  const clock = deps.clock ?? systemClock;
  const k = (key: string) => `${deps.prefix ?? ''}${key}`;
  const live = new Map<string, LiveInbound>();
  const walletLowLine = deps.lines?.walletLow ?? WALLET_LOW_LINE;
  const noAgentLine = deps.lines?.noAgent ?? NO_AGENT_LINE;

  /* ── contacts ── */

  const callerContact = async (
    accountId: Types.ObjectId,
    phoneE164: string,
  ): Promise<ContactDoc> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await ContactModel.findOne({
        accountId,
        phoneE164,
        deletedAt: null,
      }).lean<ContactDoc>();
      if (existing) return existing;
      try {
        const dnd = Boolean(await DndEntryModel.exists({ accountId, phoneE164 }));
        const created = await ContactModel.create({
          accountId,
          phoneE164,
          name: null,
          source: { type: 'inbound_call' },
          dnd,
          searchText: buildSearchText({ name: null, email: null, phoneE164, externalId: null }),
        });
        return created.toObject({ transform: false });
      } catch (err) {
        if (!isDuplicateKeyError(err) || attempt > 0) throw err;
      }
    }
    /* c8 ignore next -- the loop always returns or throws */
    throw new Error('unreachable');
  };

  /* ── missed calls ── */

  const missedRecipients = async (
    accountId: Types.ObjectId,
    number: PhoneNumberDoc,
    rang: string[],
  ): Promise<Types.ObjectId[]> => {
    if (rang.length) return rang.map((id) => new Types.ObjectId(id));
    const listed = number.inbound.ringUserIds?.map(String) ?? null;
    return (await usersWithPermission(accountId, 'calls.answer'))
      .map((u) => u.userId)
      .filter((id) => !listed || listed.includes(id.toString()));
  };

  const markMissed = async (
    callId: string,
    accountId: Types.ObjectId,
    number: PhoneNumberDoc,
    reason: MissedReason,
    rang: string[] = [],
  ): Promise<void> => {
    const done = reason === 'spam';
    await CallModel.updateOne(
      { _id: new Types.ObjectId(callId), accountId },
      {
        $set: {
          missed: {
            reason,
            callback: { status: done ? 'done' : 'open', doneBy: null, doneAt: null },
          },
        },
      },
    );
    if (!done) {
      const userIds = await missedRecipients(accountId, number, rang);
      if (userIds.length)
        await notify({
          accountId,
          userIds,
          type: 'call.sip_missed',
          title: 'Missed call',
          body: `A customer called ${number.label || 'your number'} and nobody answered.`,
          link: '/calls?view=missed',
        }).catch((err: unknown) => deps.logger.warn({ err, callId }, 'inbound: bell failed'));
    }
    await publishCallMissed(callId);
  };

  /** A call refused before it was answered — recorded for the callback list. */
  const refused = async (
    ctx: CallerCtx,
    reject: InboundReject,
    missed: MissedReason,
    endReason: CallEndReason,
    contact: ContactDoc | null,
  ): Promise<void> => {
    await deps.line.rejectInbound(ctx.channelId, reject);
    const now = new Date(clock.now());
    const status: CallStatus = reject === 'busy' ? 'busy' : 'no_answer';
    const call = await CallModel.create({
      accountId: ctx.accountId,
      direction: 'inbound',
      provider: 'sip',
      mode: 'ai',
      from: ctx.caller ?? 'anonymous',
      to: ctx.number.number,
      isTest: false,
      charged: false,
      source: { kind: null },
      contactId: contact?._id ?? null,
      status,
      endReason,
      timestamps: { queuedAt: now, ringingAt: now, answeredAt: null, endedAt: now },
      inbound: {
        did: ctx.number.number,
        phoneNumberId: ctx.number._id,
        numberLabel: ctx.number.label,
        route: ctx.number.inbound.route,
        callerHidden: ctx.caller === null,
      },
    });
    await markMissed(call._id.toString(), ctx.accountId, ctx.number, missed);
  };

  /* ── team ring ── */

  const targetsFor = async (call: LiveInbound): Promise<string[]> => {
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
      online: await (deps.onlineUsers?.(call.accountId) ?? onlineUsers(deps.redis, call.accountId)),
      ringUserIds: call.number.inbound.ringUserIds?.map(String) ?? null,
    });
  };

  const finishRing = (call: LiveInbound, outcome: RingOutcome, reason: string): void => {
    const ring = call.ring;
    if (!ring) return;
    call.ring = null;
    clock.clearTimeout(ring.timer);
    for (const userId of ring.targets)
      notifyUser(call.accountId, userId, 'call.ring_ended', {
        callId: call.callId,
        reason,
        ...(ring.winner ? { answeredBy: ring.winner } : {}),
      });
    if (outcome === 'none' && reason === 'timeout') call.ringMiss = 'no_answer';
    if (outcome === 'none' && reason === 'declined') call.ringMiss = 'no_answer';
    ring.resolve(outcome);
  };

  const ringTeam = async (call: LiveInbound, transfer: boolean): Promise<RingOutcome> => {
    if (call.leg.ended || call.ring) return 'none';
    const targets = await targetsFor(call);
    if (!targets.length) {
      call.ringMiss = 'no_agents';
      return 'none';
    }
    const sec = Math.min(call.number.inbound.ringTimeoutSec, deps.env.SIP_INBOUND_RING_MAX_SEC);
    const until = clock.now() + sec * 1000;
    const outcome = new Promise<RingOutcome>((resolve) => {
      call.ring = {
        id: `${call.callId}-${String(clock.now())}`,
        targets,
        until,
        winner: null,
        transfer,
        resolve,
        timer: clock.setTimeout(() => finishRing(call, 'none', 'timeout'), sec * 1000),
      };
    });
    for (const id of targets) call.rang.add(id);
    for (const userId of targets)
      notifyUser(call.accountId, userId, 'call.incoming', {
        callId: call.callId,
        kind: 'sip',
        contactId: call.contact?._id.toString() ?? null,
        contactName: call.contact?.name ?? null,
        from: call.contact ? call.contact.phoneE164 : null,
        did: call.number.number,
        numberLabel: call.number.label,
        transfer,
        ringUntil: new Date(until).toISOString(),
      });
    return outcome;
  };

  /** `ai_then_team`: the program's transfer step rings the team; nobody → back to the AI. */
  const transferToTeam = async (call: LiveInbound): Promise<TransferResult> => {
    if (!call.handoff) return 'failed';
    call.leg.clearAudio();
    const outcome = await ringTeam(call, true);
    return outcome === 'agent' ? 'connected' : 'failed';
  };

  /* ── commands (answer / decline / hold / media ticket), on the owning process ── */

  const command = async (call: LiveInbound, cmd: CallCommand): Promise<unknown> => {
    if (cmd.accountId !== call.accountId) throw new NotFoundError('Call not found');
    if (cmd.action === 'media_ticket' || cmd.action === 'hold') {
      if (call.agentUserId !== cmd.userId) throw new AppError('AUTH_FORBIDDEN');
      if (call.leg.ended) throw new AppError('CALL_NOT_ACTIVE');
      if (cmd.action === 'hold') {
        await call.bridge.setHold(cmd.on === true);
        return { callId: call.callId, on: call.bridge.onHold };
      }
      return {
        callId: call.callId,
        ...(await issueMediaTicket(
          { callId: call.callId, accountId: call.accountId, userId: cmd.userId },
          deps.tickets,
        )),
      };
    }
    if (cmd.action !== 'answer' && cmd.action !== 'decline') throw new AppError('CALL_NOT_ACTIVE');
    const ring = call.ring;
    if (!ring || ring.until <= clock.now() || call.leg.ended)
      throw new AppError('CALL_NOT_RINGING');
    if (!ring.targets.includes(cmd.userId)) throw new AppError('AUTH_FORBIDDEN');
    if (cmd.action === 'decline') {
      if (ring.winner) throw new AppError('CALL_ALREADY_ANSWERED');
      ring.targets = ring.targets.filter((id) => id !== cmd.userId);
      notifyUser(call.accountId, cmd.userId, 'call.ring_ended', {
        callId: call.callId,
        reason: 'declined',
      });
      if (!ring.targets.length) finishRing(call, 'none', 'declined');
      return { declined: true };
    }
    if (!(await deps.bus.claimAgent(call.accountId, cmd.userId, call.callId)))
      throw new AppError('CALL_AGENT_UNAVAILABLE');
    const winner = await deps.bus.claimAnswer(ring.id, cmd.userId);
    if (winner !== cmd.userId || ring.winner) {
      if (winner !== cmd.userId)
        await deps.bus.releaseAgent(call.accountId, cmd.userId, call.callId);
      throw new AppError('CALL_ALREADY_ANSWERED');
    }
    if (call.ring !== ring || call.leg.ended) {
      await deps.bus.releaseAgent(call.accountId, cmd.userId, call.callId);
      throw new AppError('CALL_NOT_RINGING');
    }
    ring.winner = winner;
    call.agentUserId = winner;
    await CallModel.updateOne(
      { _id: new Types.ObjectId(call.callId) },
      { $set: { agentUserId: new Types.ObjectId(winner), mode: 'human' } },
    );
    if (ring.transfer && call.handoff) {
      call.leg.clearAudio();
      await call.handoff.takeOver(call.bridge);
    }
    finishRing(call, 'agent', 'answered');
    return {
      callId: call.callId,
      ...(await issueMediaTicket(
        { callId: call.callId, accountId: call.accountId, userId: winner },
        deps.tickets,
      )),
    };
  };

  /** The answering member's media socket (`/ws/media`, ticket bound to them + this call). */
  const attachAgent = async (
    call: LiveInbound,
    input: MediaAttachInput,
    leg: CallLeg,
  ): Promise<AttachResult> => {
    if (call.leg.ended) return { ok: false, code: MEDIA_CLOSE.callEnded, reason: 'call ended' };
    if (call.agentUserId !== input.userId || call.accountId !== input.accountId)
      return { ok: false, code: MEDIA_CLOSE.forbidden, reason: 'not your call' };
    if (!call.bridge.attachAgent(leg))
      return { ok: false, code: MEDIA_CLOSE.callEnded, reason: 'already attached' };
    call.taken = true;
    // no greeting: the caller was still ringing — answer now that a person is there
    if (!call.answered) await call.leg.dial();
    return { ok: true };
  };

  /* ── the call ── */

  const runCall = async (
    ctx: CallerCtx,
    contact: ContactDoc | null,
    plan: {
      mode: 'ai' | 'team' | 'message';
      message?: { text: string; reason: CallEndReason; missed: MissedReason };
    },
  ): Promise<void> => {
    const { number, accountId } = ctx;
    const settings = number.inbound;
    const program = programSource(number);
    const usesAi =
      plan.mode === 'ai' || (plan.mode === 'team' && settings.route === 'team_then_ai');
    const callId = new Types.ObjectId();
    const now = new Date(clock.now());
    const doc = await CallModel.create({
      _id: callId,
      accountId,
      direction: 'inbound',
      provider: 'sip',
      mode: plan.mode === 'team' ? 'human' : 'ai',
      from: ctx.caller ?? 'anonymous',
      to: number.number,
      isTest: false,
      source: plan.mode === 'ai' && program ? flowSource(program) : { kind: null },
      contactId: contact?._id ?? null,
      timestamps: { queuedAt: now },
      inbound: {
        did: number.number,
        phoneNumberId: number._id,
        numberLabel: number.label,
        route: settings.route,
        callerHidden: ctx.caller === null,
      },
    });
    let call: CallDoc = doc.toObject({ transform: false });
    let leg: SipCallLeg;
    try {
      leg = await deps.line.acceptInbound({
        callId: callId.toString(),
        channelId: ctx.channelId,
        did: number.number,
      });
    } catch (err) {
      if (!(err instanceof SipLineBusyError) && !(err instanceof SipNoMediaPortError)) throw err;
      await deps.line.rejectInbound(ctx.channelId, 'busy');
      await CallModel.updateOne(
        { _id: callId },
        {
          $set: {
            status: 'busy',
            endReason: 'line_busy',
            charged: false,
            'timestamps.endedAt': new Date(clock.now()),
          },
        },
      );
      await markMissed(callId.toString(), accountId, number, 'line_busy');
      return;
    }
    await leg.ring();
    // money: a fixed line is free; a refused hold turns the call into the "not available" line
    let message = plan.mode === 'message' ? plan.message : undefined;
    let billing: CallBillingPort = new FreeBilling();
    if (!message) {
      const account = await AccountModel.findById(accountId)
        .select({ sipSettings: 1 })
        .lean<{ sipSettings?: { pulseSec?: number | null } }>();
      const held = new CallBilling(
        accountId.toString(),
        callId.toString(),
        true,
        account?.sipSettings?.pulseSec ?? null,
        usesAi,
        true,
      );
      try {
        await held.hold();
        billing = held;
        await CallModel.updateOne({ _id: callId }, { $set: { holdId: held.holdId } });
        call = { ...call, holdId: held.holdId ? new Types.ObjectId(held.holdId) : null };
      } catch {
        message = { text: walletLowLine, reason: 'wallet_empty', missed: 'wallet_low' };
        await CallModel.updateOne({ _id: callId }, { $set: { charged: false } });
      }
    }
    const state: LiveInbound = {
      callId: callId.toString(),
      accountId: accountId.toString(),
      number,
      contact,
      leg,
      bridge: new BridgeScript(),
      handoff: null,
      ring: null,
      rang: new Set(),
      agentUserId: null,
      answered: false,
      taken: false,
      presetMissed: message ? message.missed : null,
      ringMiss: null,
      callerLeft: false,
    };
    leg.onStatus((status) => {
      if (status === 'answered') state.answered = true;
      if (status === 'ended' && state.ring) {
        state.callerLeft = true;
        finishRing(state, 'none', 'ended');
      }
    });
    let script: CallScript;
    let voice = 'coral';
    let language = 'hinglish';
    let maxDurationSec: number | undefined;
    let answerNow = true;
    let answerTimeoutSec = 30;
    let ringNow = false;
    let resolveRing: (o: RingOutcome) => void = () => undefined;
    if (message) {
      script = new MessageScript(message.text, message.reason);
    } else if (plan.mode === 'ai') {
      const choice = await deps.manager.programFor(call);
      ({ voice, language } = choice);
      maxDurationSec = choice.maxDurationSec;
      state.taken = true;
      if (settings.route === 'ai_then_team') {
        state.handoff = new HandoffScript(choice.script);
        script = state.handoff;
        leg.setTransferHandler(() => transferToTeam(state));
      } else script = choice.script;
    } else {
      // team / team_then_ai
      const ring = new Promise<RingOutcome>((resolve) => {
        resolveRing = resolve;
      });
      let fallback: CallScript | null = null;
      if (settings.route === 'team_then_ai' && program) {
        const choice = await deps.manager.programFor({ ...call, source: flowSource(program) });
        ({ voice, language } = choice);
        maxDurationSec = choice.maxDurationSec;
        fallback = choice.script;
      }
      script = new TeamScript({
        greeting: settings.greeting,
        bridge: state.bridge,
        ring,
        fallback,
        noAgentLine,
        onFallback: () => {
          state.taken = true;
          // a query only runs once it is awaited / exec'd
          void CallModel.updateOne(
            { _id: callId },
            { $set: { mode: 'ai', source: program ? flowSource(program) : { kind: null } } },
          )
            .exec()
            .catch((err: unknown) =>
              deps.logger.warn({ err, callId: callId.toString() }, 'inbound: fallback not saved'),
            );
        },
      });
      answerNow = Boolean(settings.greeting);
      answerTimeoutSec =
        Math.min(settings.ringTimeoutSec, deps.env.SIP_INBOUND_RING_MAX_SEC) +
        CALL_LIMITS.readyTimeoutSec +
        5;
      ringNow = true;
    }
    live.set(state.callId, state);
    const { ended } = await deps.manager.runInboundSipSession({
      call,
      leg,
      billing,
      script,
      voice,
      language,
      ...(maxDurationSec !== undefined ? { maxDurationSec } : {}),
      answerTimeoutSec,
      record: !message,
      answerNow,
      attachAgent: (input, agentLeg) => attachAgent(state, input, agentLeg),
    });
    deps.bus.onCallCommand(state.callId, (cmd) => command(state, cmd));
    void ended.then((summary) => finish(state, summary.endReason));
    if (ringNow) {
      const outcome = await ringTeam(state, false);
      // nobody: answer (if still ringing) so the fallback AI / the line can speak
      if (outcome === 'none' && !state.answered && !leg.ended) await leg.dial();
      resolveRing(outcome);
    }
  };

  const finish = async (call: LiveInbound, endReason: CallEndReason): Promise<void> => {
    live.delete(call.callId);
    if (call.ring) {
      call.callerLeft = true;
      finishRing(call, 'none', 'ended');
    }
    if (call.agentUserId)
      await deps.bus
        .releaseAgent(call.accountId, call.agentUserId, call.callId)
        .catch(() => undefined);
    const tookByPerson = call.agentUserId !== null && call.bridge.hasAgent;
    let reason: MissedReason | null = call.presetMissed;
    if (!reason && !tookByPerson && !call.taken) {
      // the caller gave up while it rang; else nobody answered / nobody was free
      reason = call.callerLeft ? 'caller_hung_up' : (call.ringMiss ?? 'no_answer');
    }
    void endReason;
    if (reason)
      await markMissed(call.callId, new Types.ObjectId(call.accountId), call.number, reason, [
        ...call.rang,
      ]).catch((err: unknown) =>
        deps.logger.error({ err, callId: call.callId }, 'inbound: missed call not saved'),
      );
  };

  /** A trunk call reached the inbound app (`SipTelephonyProvider.onIncoming`). */
  const handleIncoming = async (incoming: IncomingSipCall): Promise<void> => {
    const claimed = await deps.redis.set(
      k(`sip:in:${incoming.channelId}`),
      '1',
      'EX',
      CLAIM_TTL_SEC,
      'NX',
    );
    if (claimed !== 'OK') return;
    const did = normalizeDid(incoming.did);
    const caller = normalizeCaller(incoming.caller);
    const number = did
      ? await PhoneNumberModel.findOne({
          number: did,
          status: 'active',
          accountId: { $ne: null },
          purpose: { $in: INBOUND_PURPOSES },
          'inbound.enabled': true,
        }).lean<PhoneNumberDoc>()
      : null;
    const account = number?.accountId
      ? await AccountModel.findById(number.accountId)
          .select({ status: 1, isPlatform: 1, voiceLine: 1 })
          .lean<{ status: string; isPlatform?: boolean; voiceLine?: AccountVoiceLine }>()
      : null;
    if (
      !number?.accountId ||
      !account ||
      account.status !== 'active' ||
      account.isPlatform ||
      effectiveLine(account, deps.env) !== 'sip'
    ) {
      deps.logger.info(
        { did: did ? maskPhone(did) : null, reason: number ? 'account' : 'number' },
        'inbound: call refused',
      );
      await deps.line.rejectInbound(incoming.channelId, 'rejected');
      return;
    }
    const ctx: CallerCtx = {
      channelId: incoming.channelId,
      number,
      accountId: number.accountId,
      caller,
    };
    if (caller) {
      const key = k(`sip:in:rate:${number.accountId.toString()}:${caller}`);
      const n = await deps.redis.incr(key);
      if (n === 1) await deps.redis.expire(key, 3600);
      if (n > deps.env.SIP_INBOUND_PER_CALLER_PER_HOUR) {
        await refused(ctx, 'busy', 'spam', 'spam_guard', null);
        return;
      }
    }
    const contact = caller ? await callerContact(number.accountId, caller) : null;
    if (!deps.manager.canTakeInbound) {
      await refused(ctx, 'busy', 'line_busy', 'line_busy', contact);
      return;
    }
    const settings = number.inbound;
    if (!withinCallHours(settings.callHours, new Date(clock.now()))) {
      if (settings.afterHours.action === 'hangup') {
        await refused(ctx, 'rejected', 'after_hours', 'outside_call_hours', contact);
        return;
      }
      if (settings.afterHours.action === 'message' || !settings.program) {
        await runCall(ctx, contact, {
          mode: 'message',
          message: {
            text: settings.afterHours.message,
            reason: 'outside_call_hours',
            missed: 'after_hours',
          },
        });
        return;
      }
      await runCall(ctx, contact, { mode: 'ai' });
      return;
    }
    const mode = settings.route === 'ai' || settings.route === 'ai_then_team' ? 'ai' : 'team';
    await runCall(ctx, contact, { mode });
  };

  return {
    handleIncoming: (incoming: IncomingSipCall) =>
      handleIncoming(incoming).catch(async (err: unknown) => {
        deps.logger.error({ err }, 'inbound: call failed');
        await deps.line.rejectInbound(incoming.channelId, 'unavailable');
      }),
    /** Live incoming calls on this process (tests, shutdown). */
    get live(): number {
      return live.size;
    },
  };
};

export type InboundSipService = ReturnType<typeof createInboundSip>;
