import { Types } from 'mongoose';

import { availableMicros } from '../../core/billing/events';
import { getOrCreateWallet } from '../../core/billing/wallets';
import { notifyAccount } from '../../core/realtime/notify';
import { isDuplicateKeyError } from '../../db/errors';
import { AccountModel } from '../../db/models/account.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import {
  OPEN_SCHEDULED_STATUSES,
  WhatsAppScheduledCallModel,
  type ScheduledAttempt,
  type ScheduledRetryOn,
  type ScheduledSkipReason,
  type WhatsAppScheduledCallDoc,
} from '../../db/models/whatsapp-scheduled-call.model';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import type { CallEndedSummary } from '../calls/session';
import { emitMessageCreated } from '../inbox/events';
import { insertSystemLine } from '../inbox/message-store';
import { notify } from '../notifications/notifications.service';
import { publishScheduledCallEvent } from '../webhooks/publish';

import type { WhatsAppCallsService } from './calls.service';
import type { CallPermissionsService } from './permissions.service';
import { programProblems } from './program';

/**
 * SAC-T8: AI WhatsApp calls placed later. Created from the inbox ("Schedule AI call"), an AI
 * agent's callback, or the API; placed by the runner in the process that owns call media.
 * At its time every dial check runs again (the same guard as a call now): permission, DND,
 * opt-out, calling window, wallet, limits. Exactly once: a row is claimed `scheduled →
 * dispatching` with a conditional update, and each try's call is unique by
 * (scheduledCallId, attempt).
 */

export const SCHEDULED_LIMITS = {
  minLeadMs: 5 * 60_000,
  maxLeadMs: 30 * 86_400_000,
  perContactOpen: 3,
  perAccountOpen: 500,
  staleClaimMs: 10 * 60_000,
  capacityRetryMs: 5 * 60_000,
  capacityRetriesMax: 3,
  /** TRAI: live calls 09:00–21:00 in the account timezone. */
  windowStart: '09:00',
  windowEnd: '21:00',
  tickMs: 15_000,
  batch: 20,
} as const;

export interface ScheduledActor {
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
  impersonatorId?: Types.ObjectId | null;
}

export interface CreateScheduledInput {
  channelId: string;
  contactId: string;
  conversationId?: string | null;
  program: { kind: 'flow' | 'agent'; id: string };
  purpose?: string | null;
  dueAt: Date;
  retry?: { max: number; gapMin: number; on: ScheduledRetryOn[] } | null;
  origin?: 'manual' | 'ai_callback' | 'api';
  idempotencyKey?: string | null;
}

export interface ScheduledWarnings {
  noPermission: boolean;
  permissionExpiresBeforeDue: boolean;
  outsideWindow: boolean;
  lowWallet: boolean;
}

const hhmmIn = (at: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

/** Inside 09:00–21:00 in the timezone. */
export const insideCallingWindow = (at: Date, timeZone: string): boolean => {
  const t = hhmmIn(at, timeZone);
  return t >= SCHEDULED_LIMITS.windowStart && t < SCHEDULED_LIMITS.windowEnd;
};

export const scheduledView = (d: WhatsAppScheduledCallDoc) => ({
  id: d._id.toString(),
  channelId: d.channelId.toString(),
  contactId: d.contactId.toString(),
  conversationId: d.conversationId ? d.conversationId.toString() : null,
  program: { kind: d.program.kind, id: d.program.id.toString() },
  purpose: d.purpose,
  dueAt: d.dueAt.toISOString(),
  timezone: d.timezone,
  status: d.status,
  skipReason: d.skipReason,
  origin: d.origin,
  attempt: d.attempt,
  retry: { max: d.retry.max, gapMin: d.retry.gapMin, on: [...d.retry.on] },
  attempts: d.attempts.map((a) => ({
    at: a.at.toISOString(),
    callId: a.callId ? a.callId.toString() : null,
    result: a.result,
    reason: a.reason,
  })),
  shiftedAt: d.shiftedAt ? d.shiftedAt.toISOString() : null,
  callIds: d.callIds.map((c) => c.toString()),
  createdBy: d.createdBy.toString(),
  cancelledAt: d.cancelledAt ? d.cancelledAt.toISOString() : null,
  createdAt: d.createdAt.toISOString(),
  updatedAt: d.updatedAt.toISOString(),
});
export type ScheduledCallView = ReturnType<typeof scheduledView>;

/** Dial-guard refusal → why a scheduled call was not placed. */
export const skipReasonOf = (
  err: unknown,
):
  | { kind: 'skip'; reason: ScheduledSkipReason }
  | { kind: 'shift'; at: Date | null }
  | {
      kind: 'capacity';
    }
  | { kind: 'fail'; reason: string } => {
  if (!(err instanceof AppError)) return { kind: 'fail', reason: 'error' };
  const detail = err.details?.[0]?.message ?? '';
  switch (err.code) {
    case 'CALL_OUTSIDE_WINDOW': {
      const at = detail ? new Date(detail) : null;
      return { kind: 'shift', at: at && !Number.isNaN(at.getTime()) ? at : null };
    }
    case 'WHATSAPP_CALL_ACTIVE':
    case 'CALL_LIMIT_REACHED':
    case 'CALL_CAPACITY':
      return { kind: 'capacity' };
    case 'WHATSAPP_CHANNEL_NOT_READY':
      return { kind: 'skip', reason: 'channel_down' };
    case 'WHATSAPP_CALLING_DISABLED':
    case 'WHATSAPP_CALLING_UNAVAILABLE':
    case 'WHATSAPP_CALLING_RESTRICTED':
      return { kind: 'skip', reason: 'calling_disabled' };
    case 'RESOURCE_NOT_FOUND':
      return { kind: 'skip', reason: 'contact_deleted' };
    case 'CALL_NOT_ALLOWED':
      return {
        kind: 'skip',
        reason: detail === 'dnd' ? 'dnd' : detail === 'opted_out' ? 'opted_out' : 'not_allowed',
      };
    case 'VALIDATION_FAILED':
      return { kind: 'skip', reason: 'program_inactive' };
    case 'WHATSAPP_CALL_PERMISSION_MISSING':
    case 'WHATSAPP_CALL_PERMISSION_CHECK_FAILED':
    case 'WHATSAPP_CALL_LIMIT_REACHED':
      return { kind: 'skip', reason: 'no_permission' };
    case 'WALLET_INSUFFICIENT_BALANCE':
    case 'WALLET_BUDGET_EXCEEDED':
      return { kind: 'skip', reason: 'wallet' };
    case 'AUTH_FORBIDDEN':
    case 'AUTH_ACCOUNT_SUSPENDED':
      return { kind: 'skip', reason: 'not_allowed' };
    default:
      return { kind: 'fail', reason: err.code.toLowerCase().slice(0, 64) };
  }
};

/** What a finished call means for its scheduled call. */
export const resultOf = (s: Pick<CallEndedSummary, 'status' | 'endReason' | 'durationSec'>) => {
  if (s.status === 'completed' && s.durationSec > 0) return 'answered' as const;
  if (s.status === 'busy' || s.endReason === 'busy') return 'busy' as const;
  if (s.status === 'no_answer' || s.endReason === 'not_answered') return 'no_answer' as const;
  if (s.status === 'completed') return 'answered' as const;
  return 'failed' as const;
};

export interface ScheduledDeps {
  logger: Logger;
  /** Places the calls (the process that owns call media); absent = create / list only. */
  calls?: Pick<WhatsAppCallsService, 'startOutbound' | 'onCallEnded'> | null;
  permissions?: Pick<CallPermissionsService, 'statusFor'> | null;
  now?: () => Date;
}

export const createScheduledCalls = (deps: ScheduledDeps) => {
  const now = () => deps.now?.() ?? new Date();

  const emit = (d: WhatsAppScheduledCallDoc) =>
    notifyAccount(d.accountId.toString(), 'whatsapp_call.scheduled_updated', {
      id: d._id.toString(),
      status: d.status,
      contactId: d.contactId.toString(),
      conversationId: d.conversationId ? d.conversationId.toString() : null,
    });

  /** A centred line in the chat ("AI call scheduled …"). */
  const chatLine = async (d: WhatsAppScheduledCallDoc, kind: string) => {
    if (!d.conversationId) return;
    const conversation = await ConversationModel.findOne({
      _id: d.conversationId,
      accountId: d.accountId,
    }).lean<ConversationDoc>();
    if (!conversation) return;
    try {
      emitMessageCreated(await insertSystemLine(conversation, kind, now()));
    } catch (err) {
      deps.logger.warn({ err, id: d._id.toString() }, 'scheduled call: chat line failed');
    }
  };

  const loadOwn = async (accountId: Types.ObjectId, id: string) => {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Scheduled call not found');
    const d = await WhatsAppScheduledCallModel.findOne({
      _id: new Types.ObjectId(id),
      accountId,
    }).lean<WhatsAppScheduledCallDoc>();
    if (!d) throw new NotFoundError('Scheduled call not found');
    return d;
  };

  const warningsFor = async (
    accountId: Types.ObjectId,
    channelId: Types.ObjectId,
    contactId: Types.ObjectId,
    dueAt: Date,
    timezone: string,
  ): Promise<ScheduledWarnings> => {
    let noPermission = false;
    let permissionExpiresBeforeDue = false;
    if (deps.permissions) {
      try {
        const p = await deps.permissions.statusFor(accountId, channelId, contactId.toString());
        noPermission = !p.canCall;
        permissionExpiresBeforeDue = Boolean(
          p.canCall && p.expiresAt && Date.parse(p.expiresAt) < dueAt.getTime(),
        );
      } catch {
        // the check runs again at the call's time
      }
    }
    const wallet = await getOrCreateWallet(accountId);
    return {
      noPermission,
      permissionExpiresBeforeDue,
      outsideWindow: !insideCallingWindow(dueAt, timezone),
      lowWallet: availableMicros(wallet) <= 0,
    };
  };

  const create = async (actor: ScheduledActor, input: CreateScheduledInput) => {
    const t = now();
    const problems: ErrorDetail[] = [];
    if (input.dueAt.getTime() < t.getTime() + SCHEDULED_LIMITS.minLeadMs) {
      problems.push({ path: 'dueAt', message: 'Pick a time at least 5 minutes from now' });
    }
    if (input.dueAt.getTime() > t.getTime() + SCHEDULED_LIMITS.maxLeadMs) {
      problems.push({ path: 'dueAt', message: 'At most 30 days ahead' });
    }
    if (!Types.ObjectId.isValid(input.channelId) || !Types.ObjectId.isValid(input.contactId)) {
      throw new NotFoundError();
    }
    const channel = await WhatsAppChannelModel.findOne({
      _id: new Types.ObjectId(input.channelId),
      accountId: actor.accountId,
    })
      .select({ status: 1, accountId: 1 })
      .lean<Pick<WhatsAppChannelDoc, '_id' | 'status'>>();
    if (!channel || channel.status === 'disconnected') {
      throw new NotFoundError('WhatsApp number not found');
    }
    const contact = await ContactModel.findOne({
      _id: new Types.ObjectId(input.contactId),
      accountId: actor.accountId,
      deletedAt: null,
    })
      .select({ _id: 1 })
      .lean<Pick<ContactDoc, '_id'>>();
    if (!contact) throw new NotFoundError('Contact not found');
    problems.push(...(await programProblems(actor.accountId, input.program, 'program')));
    if (problems.length) throw new ValidationError(problems);
    const [perContact, perAccount] = await Promise.all([
      WhatsAppScheduledCallModel.countDocuments({
        accountId: actor.accountId,
        contactId: contact._id,
        status: { $in: [...OPEN_SCHEDULED_STATUSES] },
      }),
      WhatsAppScheduledCallModel.countDocuments({
        accountId: actor.accountId,
        status: { $in: [...OPEN_SCHEDULED_STATUSES] },
      }),
    ]);
    if (perContact >= SCHEDULED_LIMITS.perContactOpen) {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'This customer already has 3 scheduled calls — cancel one first.',
      );
    }
    if (perAccount >= SCHEDULED_LIMITS.perAccountOpen) {
      throw new ConflictError('CONFLICT_INVALID_STATE', 'At most 500 scheduled calls at a time.');
    }
    const account = await AccountModel.findById(actor.accountId)
      .select({ timezone: 1 })
      .lean<{ timezone?: string }>();
    const timezone = account?.timezone ?? 'Asia/Kolkata';
    let conversationId: Types.ObjectId | null = null;
    if (input.conversationId && Types.ObjectId.isValid(input.conversationId)) {
      const c = await ConversationModel.findOne({
        _id: new Types.ObjectId(input.conversationId),
        accountId: actor.accountId,
        channelId: channel._id,
      })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId }>();
      conversationId = c?._id ?? null;
    }
    if (!conversationId) {
      const c = await ConversationModel.findOne({
        accountId: actor.accountId,
        channelId: channel._id,
        contactId: contact._id,
      })
        .sort({ updatedAt: -1 })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId }>();
      conversationId = c?._id ?? null;
    }
    let doc: WhatsAppScheduledCallDoc;
    try {
      doc = (
        await WhatsAppScheduledCallModel.create({
          accountId: actor.accountId,
          channelId: channel._id,
          contactId: contact._id,
          conversationId,
          program: { kind: input.program.kind, id: new Types.ObjectId(input.program.id) },
          purpose: input.purpose?.trim() || null,
          dueAt: input.dueAt,
          timezone,
          origin: input.origin ?? 'manual',
          retry: input.retry ?? { max: 0, gapMin: 30, on: [] },
          createdBy: actor.userId,
          impersonatorId: actor.impersonatorId ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
        })
      ).toObject({ transform: false });
    } catch (err) {
      if (isDuplicateKeyError(err) && input.idempotencyKey) {
        const existing = await WhatsAppScheduledCallModel.findOne({
          accountId: actor.accountId,
          idempotencyKey: input.idempotencyKey,
        }).lean<WhatsAppScheduledCallDoc>();
        if (existing) {
          return {
            scheduledCall: scheduledView(existing),
            warnings: await warningsFor(
              actor.accountId,
              existing.channelId,
              existing.contactId,
              existing.dueAt,
              existing.timezone,
            ),
            replay: true,
          };
        }
      }
      throw err;
    }
    emit(doc);
    await chatLine(
      doc,
      doc.origin === 'ai_callback' ? 'call_callback_scheduled' : 'call_scheduled',
    );
    await publishScheduledCallEvent('whatsapp_call.scheduled', doc);
    return {
      scheduledCall: scheduledView(doc),
      warnings: await warningsFor(actor.accountId, channel._id, contact._id, doc.dueAt, timezone),
      replay: false,
    };
  };

  const list = async (
    accountId: Types.ObjectId,
    q: {
      status?: string | undefined;
      contactId?: string | undefined;
      channelId?: string | undefined;
      from?: Date | undefined;
      to?: Date | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ) => {
    const filter: Record<string, unknown> = { accountId };
    if (q.status === 'open') filter.status = { $in: [...OPEN_SCHEDULED_STATUSES] };
    else if (q.status) filter.status = q.status;
    if (q.contactId && Types.ObjectId.isValid(q.contactId))
      filter.contactId = new Types.ObjectId(q.contactId);
    if (q.channelId && Types.ObjectId.isValid(q.channelId))
      filter.channelId = new Types.ObjectId(q.channelId);
    if (q.from || q.to) {
      filter.dueAt = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lt: q.to } : {}) };
    }
    if (q.cursor && Types.ObjectId.isValid(q.cursor))
      filter._id = { $lt: new Types.ObjectId(q.cursor) };
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
    const rows = await WhatsAppScheduledCallModel.find(filter)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean<WhatsAppScheduledCallDoc[]>();
    const page = rows.slice(0, limit);
    return {
      items: page.map(scheduledView),
      nextCursor: rows.length > limit ? (page.at(-1)?._id.toString() ?? null) : null,
    };
  };

  const get = async (accountId: Types.ObjectId, id: string) =>
    scheduledView(await loadOwn(accountId, id));

  const update = async (
    actor: ScheduledActor,
    id: string,
    patch: {
      dueAt?: Date | undefined;
      program?: { kind: 'flow' | 'agent'; id: string } | undefined;
      purpose?: string | null | undefined;
      retry?: { max: number; gapMin: number; on: ScheduledRetryOn[] } | undefined;
    },
  ) => {
    const current = await loadOwn(actor.accountId, id);
    if (current.status !== 'scheduled') {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'Only a waiting scheduled call can change.',
      );
    }
    const problems: ErrorDetail[] = [];
    const t = now();
    if (patch.dueAt && patch.dueAt.getTime() < t.getTime() + SCHEDULED_LIMITS.minLeadMs)
      problems.push({ path: 'dueAt', message: 'Pick a time at least 5 minutes from now' });
    if (patch.dueAt && patch.dueAt.getTime() > t.getTime() + SCHEDULED_LIMITS.maxLeadMs)
      problems.push({ path: 'dueAt', message: 'At most 30 days ahead' });
    if (patch.program)
      problems.push(...(await programProblems(actor.accountId, patch.program, 'program')));
    if (problems.length) throw new ValidationError(problems);
    const set: Record<string, unknown> = {};
    if (patch.dueAt) Object.assign(set, { dueAt: patch.dueAt, shiftedAt: null });
    if (patch.program)
      set.program = { kind: patch.program.kind, id: new Types.ObjectId(patch.program.id) };
    if (patch.purpose !== undefined) set.purpose = patch.purpose?.trim() || null;
    if (patch.retry) set.retry = patch.retry;
    const updated = await WhatsAppScheduledCallModel.findOneAndUpdate(
      { _id: current._id, accountId: actor.accountId, status: 'scheduled' },
      { $set: set },
      { returnDocument: 'after' },
    ).lean<WhatsAppScheduledCallDoc>();
    if (!updated) {
      throw new ConflictError('CONFLICT_INVALID_STATE', 'This call is being placed right now.');
    }
    emit(updated);
    return scheduledView(updated);
  };

  const cancel = async (actor: ScheduledActor, id: string) => {
    const current = await loadOwn(actor.accountId, id);
    const updated = await WhatsAppScheduledCallModel.findOneAndUpdate(
      { _id: current._id, accountId: actor.accountId, status: 'scheduled' },
      { $set: { status: 'cancelled', cancelledBy: actor.userId, cancelledAt: now() } },
      { returnDocument: 'after' },
    ).lean<WhatsAppScheduledCallDoc>();
    if (!updated) {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        current.status === 'cancelled'
          ? 'Already cancelled.'
          : 'This call was already placed or finished.',
      );
    }
    emit(updated);
    await chatLine(updated, 'call_schedule_cancelled');
    return scheduledView(updated);
  };

  /* ── the runner (the process that owns call media) ── */

  const finish = async (
    d: WhatsAppScheduledCallDoc,
    set: Partial<WhatsAppScheduledCallDoc>,
    attempt: ScheduledAttempt | null,
  ): Promise<WhatsAppScheduledCallDoc | null> => {
    const updated = await WhatsAppScheduledCallModel.findOneAndUpdate(
      { _id: d._id },
      {
        $set: { ...set, claimedAt: null },
        ...(attempt ? { $push: { attempts: attempt } } : {}),
      },
      { returnDocument: 'after' },
    ).lean<WhatsAppScheduledCallDoc>();
    if (updated) emit(updated);
    return updated;
  };

  const skipped = async (d: WhatsAppScheduledCallDoc, reason: ScheduledSkipReason) => {
    const done = await finish(
      d,
      { status: 'skipped', skipReason: reason },
      { at: now(), callId: null, result: 'skipped', reason },
    );
    if (!done) return;
    await chatLine(done, 'call_schedule_skipped');
    await publishScheduledCallEvent('whatsapp_call.scheduled_skipped', done);
    await notify({
      accountId: done.accountId,
      userIds: [done.createdBy],
      type: 'whatsapp.scheduled_call_failed',
      title: 'Scheduled AI call not placed',
      body: `The AI call was skipped: ${reason.replace(/_/g, ' ')}.`,
      link: done.conversationId
        ? `/inbox/${done.conversationId.toString()}`
        : '/calls?tab=scheduled',
    });
  };

  /** Places one claimed scheduled call (or skips / shifts / retries it). */
  const dispatchOne = async (d: WhatsAppScheduledCallDoc): Promise<void> => {
    const calls = deps.calls;
    if (!calls) return;
    try {
      const res = await calls.startOutbound(
        {
          type: 'user',
          id: d.createdBy,
          userId: d.createdBy,
          accountId: d.accountId,
          impersonatorId: null,
          ip: null,
        },
        {
          channelId: d.channelId.toString(),
          contactId: d.contactId.toString(),
          mode: 'ai',
          program: { kind: d.program.kind, id: d.program.id.toString() },
          scheduled: { id: d._id.toString(), attempt: d.attempt + 1 },
        },
      );
      const callId = new Types.ObjectId(res.callId);
      await WhatsAppScheduledCallModel.updateOne(
        { _id: d._id },
        { $set: { status: 'calling', claimedAt: null }, $addToSet: { callIds: callId } },
      );
      emit({ ...d, status: 'calling' });
    } catch (err) {
      const why = skipReasonOf(err);
      if (why.kind === 'shift') {
        const at = why.at;
        if (!d.shiftedAt && at && at.getTime() - d.dueAt.getTime() < 2 * 86_400_000) {
          await finish(d, { status: 'scheduled', dueAt: at, shiftedAt: now() }, null);
          return;
        }
        await skipped(d, 'outside_window');
        return;
      }
      if (why.kind === 'capacity') {
        if (d.capacityRetries < SCHEDULED_LIMITS.capacityRetriesMax) {
          await WhatsAppScheduledCallModel.updateOne(
            { _id: d._id },
            {
              $set: {
                status: 'scheduled',
                claimedAt: null,
                dueAt: new Date(now().getTime() + SCHEDULED_LIMITS.capacityRetryMs),
              },
              $inc: { capacityRetries: 1 },
            },
          );
          return;
        }
        await skipped(d, 'capacity');
        return;
      }
      if (why.kind === 'skip') {
        await skipped(d, why.reason);
        return;
      }
      deps.logger.warn({ err, id: d._id.toString() }, 'scheduled call: dispatch failed');
      const failed = await finish(
        d,
        { status: 'failed', skipReason: null },
        { at: now(), callId: null, result: 'failed', reason: why.reason },
      );
      if (failed)
        await notify({
          accountId: failed.accountId,
          userIds: [failed.createdBy],
          type: 'whatsapp.scheduled_call_failed',
          title: 'Scheduled AI call failed',
          body: 'The AI call could not be placed.',
          link: '/calls?tab=scheduled',
        });
    }
  };

  /** One pass: stale claims back, due rows claimed (exactly once) and placed. */
  const tick = async (): Promise<number> => {
    const t = now();
    await WhatsAppScheduledCallModel.updateMany(
      {
        status: 'dispatching',
        claimedAt: { $lt: new Date(t.getTime() - SCHEDULED_LIMITS.staleClaimMs) },
      },
      { $set: { status: 'scheduled', claimedAt: null } },
    );
    let placed = 0;
    for (let i = 0; i < SCHEDULED_LIMITS.batch; i += 1) {
      const claimed = await WhatsAppScheduledCallModel.findOneAndUpdate(
        { status: 'scheduled', dueAt: { $lte: t } },
        { $set: { status: 'dispatching', claimedAt: t } },
        { sort: { dueAt: 1 }, returnDocument: 'after' },
      ).lean<WhatsAppScheduledCallDoc>();
      if (!claimed) break;
      await dispatchOne(claimed);
      placed += 1;
    }
    return placed;
  };

  /** The end of a scheduled call's call: done, retry later, or failed. */
  const onCallEnded = async (summary: CallEndedSummary): Promise<void> => {
    const callId = new Types.ObjectId(summary.callId);
    const d = await WhatsAppScheduledCallModel.findOne({
      callIds: callId,
      status: 'calling',
    }).lean<WhatsAppScheduledCallDoc>();
    if (!d) return;
    const result = resultOf(summary);
    const attempt: ScheduledAttempt = {
      at: now(),
      callId,
      result,
      reason: summary.endReason,
    };
    if (result !== 'answered' && d.retry.on.includes(result) && d.attempt < d.retry.max) {
      await finish(
        d,
        {
          status: 'scheduled',
          attempt: d.attempt + 1,
          dueAt: new Date(now().getTime() + d.retry.gapMin * 60_000),
          shiftedAt: null,
        },
        attempt,
      );
      return;
    }
    await finish(d, { status: result === 'answered' ? 'done' : 'failed' }, attempt);
  };

  let timer: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  let running: Promise<unknown> | null = null;

  /** Starts the runner where calls are placed (`server.ts`). */
  const start = (): void => {
    if (!deps.calls || timer) return;
    const off = deps.calls.onCallEnded((s) =>
      onCallEnded(s).catch((err: unknown) =>
        deps.logger.warn({ err }, 'scheduled call: end handling failed'),
      ),
    );
    unsubscribe = () => {
      off();
    };
    timer = setInterval(() => {
      if (running) return;
      running = tick()
        .catch((err: unknown) => deps.logger.error({ err }, 'scheduled call: tick failed'))
        .finally(() => {
          running = null;
        });
    }, SCHEDULED_LIMITS.tickMs);
    timer.unref();
  };

  const stop = async (): Promise<void> => {
    if (timer) clearInterval(timer);
    timer = null;
    unsubscribe?.();
    unsubscribe = null;
    await running;
  };

  return { create, list, get, update, cancel, tick, onCallEnded, start, stop, warningsFor };
};

export type ScheduledCallsService = ReturnType<typeof createScheduledCalls>;
