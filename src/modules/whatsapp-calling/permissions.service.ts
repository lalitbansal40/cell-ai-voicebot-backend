import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';

import { WHATSAPP_CALL_LIMITS } from '../../config/limits';
import type { MetaCallPermission } from '../../core/meta';
import { notifyAccount } from '../../core/realtime/notify';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ConversationModel, type ConversationDoc } from '../../db/models/conversation.model';
import { MessageModel } from '../../db/models/message.model';
import {
  CALLABLE_PERMISSION_STATUSES,
  PERMISSION_HISTORY_MAX,
  WhatsAppCallPermissionModel,
  type CallPermissionHistoryEntry,
  type CallPermissionStatus,
  type WhatsAppCallPermissionDoc,
} from '../../db/models/whatsapp-call-permission.model';
import {
  defaultCalling,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';
import type { InboxContext } from '../inbox/context';
import { upsertConversation } from '../inbox/conversation-store';
import { isWindowOpen, sendMessage } from '../inbox/outbound.service';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import { numberName } from '../whatsapp/channel-status';
import { nowOf } from '../whatsapp/context';

import { activeRestrictions, bicCountryBlocked } from './availability';
import { withCallErrors } from './errors';
import { CALLING_NOTIFICATIONS } from './notification-types';
import type { CallingDeps } from './settings.service';

/**
 * Call permissions (PHASE_12_PLAN §1e, PHASE_12_PROMPT T12.5). Meta's
 * `GET call_permissions` is the truth before every request / call (cached 60 s in
 * Redis); our row is the UI state, the counters and the history. Requests go out
 * through the inbox send pipeline (priced + held like any message).
 */
export interface PermissionDeps extends CallingDeps {
  inbox: InboxContext;
}

/** What the chat / contact panel shows (reason codes match the dial guard). */
export interface PermissionPanel {
  status: CallPermissionStatus;
  expiresAt: string | null;
  canCall: boolean;
  canRequest: boolean;
  nextRequestAt: string | null;
  reason: string | null;
}

export interface PermissionActor extends AuditActorInput {
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
  ip?: string | null;
}

const DAY_MS = 86_400_000;
const permCacheKey = (channelId: Types.ObjectId | string, waId: string) =>
  `call:wa:perm:${channelId.toString()}:${waId}`;

const waIdOf = (contact: Pick<ContactDoc, 'phoneE164' | 'whatsapp'>): string =>
  contact.whatsapp?.waId ?? contact.phoneE164.replace(/\D/g, '');

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const valid = (row: Pick<WhatsAppCallPermissionDoc, 'status' | 'expiresAt'> | null, now: Date) =>
  Boolean(
    row &&
    CALLABLE_PERMISSION_STATUSES.includes(row.status) &&
    (row.status === 'permanent' || !row.expiresAt || row.expiresAt.getTime() > now.getTime()),
  );

const historyPush = (entry: CallPermissionHistoryEntry) => ({
  history: { $each: [entry], $slice: -PERMISSION_HISTORY_MAX },
});

export const createCallPermissions = (deps: PermissionDeps) => {
  const { ctx } = deps;

  /** Meta's view (cached `permissionCacheSec`); `fresh` skips the cache. */
  const metaPermission = async (
    channel: WhatsAppChannelDoc,
    waId: string,
    options: { fresh?: boolean } = {},
  ): Promise<MetaCallPermission> => {
    const key = permCacheKey(channel._id, waId);
    if (!options.fresh) {
      const cached = await ctx.redis.get(key);
      if (cached) {
        const raw = JSON.parse(cached) as MetaCallPermission & { expiresAt: string | null };
        return {
          status: raw.status,
          expiresAt: raw.expiresAt ? new Date(raw.expiresAt) : null,
          actions: raw.actions.map((a) => ({
            ...a,
            limits: a.limits.map((l) => ({
              ...l,
              limitExpiresAt: l.limitExpiresAt ? new Date(l.limitExpiresAt) : null,
            })),
          })),
        };
      }
    }
    const { token } = await deps.token(channel._id);
    const fresh = await withCallErrors(() =>
      ctx.meta.getCallPermissions(token, channel.phoneNumberId ?? '', waId),
    ).catch((err: unknown) => {
      // an API problem never lets a call / request through
      if (err instanceof AppError && err.code !== 'WHATSAPP_CALL_PERMISSION_CHECK_FAILED') {
        throw new AppError('WHATSAPP_CALL_PERMISSION_CHECK_FAILED', undefined, undefined, {
          cause: err,
        });
      }
      throw err;
    });
    await ctx.redis.set(key, JSON.stringify(fresh), 'EX', WHATSAPP_CALL_LIMITS.permissionCacheSec);
    return fresh;
  };

  /** Meta's last answer on our row (UI / support), only when the row exists. */
  const recordMeta = (
    accountId: Types.ObjectId,
    channelId: Types.ObjectId,
    contactId: Types.ObjectId,
    meta: MetaCallPermission,
  ) =>
    WhatsAppCallPermissionModel.updateOne(
      { accountId, channelId, contactId },
      { $set: { metaCheckedAt: nowOf(ctx), metaActions: meta.actions } },
    );

  const forgetMeta = (channelId: Types.ObjectId, waId: string) =>
    ctx.redis.del(permCacheKey(channelId, waId));

  const loadRow = (
    accountId: Types.ObjectId,
    channelId: Types.ObjectId,
    contactId: Types.ObjectId,
  ) =>
    WhatsAppCallPermissionModel.findOne({
      accountId,
      channelId,
      contactId,
    }).lean<WhatsAppCallPermissionDoc>();

  const emitUpdated = (row: WhatsAppCallPermissionDoc) => {
    notifyAccount(row.accountId.toString(), 'whatsapp.call_permission.updated', {
      contactId: row.contactId.toString(),
      channelId: row.channelId.toString(),
      status: row.status,
      expiresAt: iso(row.expiresAt),
    });
  };

  const upsertRow = async (
    accountId: Types.ObjectId,
    channelId: Types.ObjectId,
    contactId: Types.ObjectId,
    update: Record<string, unknown>,
  ): Promise<WhatsAppCallPermissionDoc> => {
    const row = await WhatsAppCallPermissionModel.findOneAndUpdate(
      { accountId, channelId, contactId },
      update,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean<WhatsAppCallPermissionDoc>();
    if (!row) throw new NotFoundError('Call permission not found');
    emitUpdated(row);
    return row;
  };

  const loadChannel = async (accountId: Types.ObjectId, channelId: string | Types.ObjectId) => {
    const channel = await WhatsAppChannelModel.findOne({
      _id: new Types.ObjectId(channelId),
      accountId,
    }).lean<WhatsAppChannelDoc>();
    if (!channel) throw new NotFoundError('WhatsApp number not found');
    return channel;
  };

  const loadContact = async (accountId: Types.ObjectId, contactId: string | Types.ObjectId) => {
    const contact = await ContactModel.findOne({
      _id: new Types.ObjectId(contactId),
      accountId,
      deletedAt: null,
    }).lean<ContactDoc>();
    if (!contact) throw new NotFoundError('Contact not found');
    return contact;
  };

  /** Why the number can't call / ask now (null = it can). */
  const channelBlock = (channel: WhatsAppChannelDoc, now: Date): string | null => {
    const calling = channel.calling ?? defaultCalling();
    if (channel.status !== 'connected' && channel.status !== 'action_needed')
      return 'not_connected';
    if (calling.status === 'unavailable') return 'calling_unavailable';
    if (calling.status !== 'enabled') return 'calling_disabled';
    if (bicCountryBlocked(channel)) return 'country';
    if (activeRestrictions(calling, 'business', now).length) return 'restricted';
    return null;
  };

  /** Why the contact can't be asked / called (null = fine). */
  const contactBlock = async (
    channel: WhatsAppChannelDoc,
    contact: ContactDoc,
  ): Promise<string | null> => {
    if (contact.dnd) return 'dnd';
    if (contact.optedOutAt) return 'opted_out';
    if (contact.whatsapp?.blocked) return 'blocked';
    const conversation = await ConversationModel.findOne({
      accountId: channel.accountId,
      channelId: channel._id,
      waId: waIdOf(contact),
    })
      .select({ blocked: 1 })
      .lean<{ blocked: boolean }>();
    return conversation?.blocked ? 'blocked' : null;
  };

  const requestLimitOf = (row: WhatsAppCallPermissionDoc | null, now: Date) => {
    const day = (row?.requests.day ?? []).filter((t) => t.getTime() > now.getTime() - DAY_MS);
    const week = (row?.requests.week ?? []).filter((t) => t.getTime() > now.getTime() - 7 * DAY_MS);
    const dayFull = day.length >= WHATSAPP_CALL_LIMITS.permissionRequestsPerDay;
    const weekFull = week.length >= WHATSAPP_CALL_LIMITS.permissionRequestsPerWeek;
    const next = [
      dayFull && day[0] ? day[0].getTime() + DAY_MS : 0,
      weekFull && week[0] ? week[0].getTime() + 7 * DAY_MS : 0,
    ].reduce((a, b) => Math.max(a, b), 0);
    return { day, week, full: dayFull || weekFull, nextAt: next ? new Date(next) : null };
  };

  /** Meta's limit for an action: can it be done, and when again. */
  const metaAction = (meta: MetaCallPermission, action: string) => {
    const a = meta.actions.find((x) => x.action === action);
    const next = (a?.limits ?? [])
      .map((l) => l.limitExpiresAt?.getTime() ?? 0)
      .reduce((x, y) => Math.max(x, y), 0);
    return { can: a ? a.canPerform : true, nextAt: next ? new Date(next) : null };
  };

  /**
   * The panel state (row + Meta with the 60 s cache). Meta errors make the state
   * "can't check" — never "allowed".
   */
  const statusFor = async (
    accountId: Types.ObjectId,
    channelId: string | Types.ObjectId,
    contactId: string | Types.ObjectId,
    options: { refresh?: boolean } = {},
  ): Promise<PermissionPanel> => {
    const now = nowOf(ctx);
    const channel = await loadChannel(accountId, channelId);
    const contact = await loadContact(accountId, contactId);
    const row = await loadRow(accountId, channel._id, contact._id);
    const status: CallPermissionStatus =
      row && row.status === 'temporary' && !valid(row, now) ? 'expired' : (row?.status ?? 'none');
    const base = {
      status,
      expiresAt: status === 'temporary' ? iso(row?.expiresAt) : null,
      nextRequestAt: null as string | null,
    };
    const block = channelBlock(channel, now) ?? (await contactBlock(channel, contact));
    if (block) return { ...base, canCall: false, canRequest: false, reason: block };
    let meta: MetaCallPermission;
    try {
      meta = await metaPermission(channel, waIdOf(contact), { fresh: options.refresh ?? false });
    } catch {
      return { ...base, canCall: false, canRequest: false, reason: 'check_failed' };
    }
    await recordMeta(accountId, channel._id, contact._id, meta);
    const ours = requestLimitOf(row, now);
    const metaReq = metaAction(meta, 'send_call_permission_request');
    const metaCall = metaAction(meta, 'start_call');
    // Meta decides; our row only adds the history and the counters
    const allowed = meta.status !== 'no_permission';
    const canCall = allowed && metaCall.can;
    const canRequest = !allowed && !ours.full && metaReq.can;
    const next = [
      ours.nextAt?.getTime() ?? 0,
      metaReq.can ? 0 : (metaReq.nextAt?.getTime() ?? 0),
    ].reduce((a, b) => Math.max(a, b), 0);
    return {
      status:
        allowed && !valid(row, now)
          ? meta.status === 'permanent'
            ? 'permanent'
            : 'temporary'
          : status,
      expiresAt: allowed ? iso(meta.expiresAt ?? row?.expiresAt) : base.expiresAt,
      canCall,
      canRequest,
      nextRequestAt: !canRequest && next ? new Date(next).toISOString() : null,
      reason: canCall ? null : !allowed ? 'no_permission' : !metaCall.can ? 'call_limit' : null,
    };
  };

  /** The WABA's approved call permission template (Phase 11), if any. */
  const permissionTemplate = (channel: WhatsAppChannelDoc) =>
    WhatsAppTemplateModel.findOne({
      accountId: channel.accountId,
      wabaId: channel.wabaId,
      purpose: 'call_permission',
      status: 'APPROVED',
    })
      .select({ _id: 1 })
      .lean<{ _id: Types.ObjectId }>();

  /**
   * Asks the customer to allow calls (plan §1e steps 1–6): number → contact → not
   * allowed yet → our + Meta's limits → interactive in the window / the approved
   * template outside it → row `requested`.
   */
  const request = async (
    actor: PermissionActor,
    input: { channelId: string; contactId: string; body?: string | null },
  ) => {
    const now = nowOf(ctx);
    const channel = await loadChannel(actor.accountId, input.channelId);
    const contact = await loadContact(actor.accountId, input.contactId);
    const block = channelBlock(channel, now);
    if (block === 'calling_unavailable' || block === 'country' || block === 'not_connected') {
      throw new AppError('WHATSAPP_CALLING_UNAVAILABLE', undefined, [
        { path: 'channelId', message: block },
      ]);
    }
    if (block === 'calling_disabled') throw new AppError('WHATSAPP_CALLING_DISABLED');
    if (block === 'restricted') throw new AppError('WHATSAPP_CALLING_RESTRICTED');
    const who = await contactBlock(channel, contact);
    if (who) {
      throw new AppError('CALL_NOT_ALLOWED', "This customer can't be asked for call permission", [
        { path: 'contactId', message: who },
      ]);
    }
    const row = await loadRow(actor.accountId, channel._id, contact._id);
    if (valid(row, now)) throw new AppError('WHATSAPP_CALL_PERMISSION_EXISTS');
    const ours = requestLimitOf(row, now);
    if (ours.full) {
      throw new AppError(
        'WHATSAPP_CALL_PERMISSION_LIMIT',
        undefined,
        [{ path: 'nextRequestAt', message: ours.nextAt?.toISOString() ?? '' }],
        ours.nextAt
          ? { retryAfterSec: Math.ceil((ours.nextAt.getTime() - now.getTime()) / 1000) }
          : {},
      );
    }
    const waId = waIdOf(contact);
    const meta = await metaPermission(channel, waId, { fresh: true });
    await recordMeta(actor.accountId, channel._id, contact._id, meta);
    if (meta.status !== 'no_permission') throw new AppError('WHATSAPP_CALL_PERMISSION_EXISTS');
    const metaReq = metaAction(meta, 'send_call_permission_request');
    if (!metaReq.can) {
      throw new AppError(
        'WHATSAPP_CALL_PERMISSION_LIMIT',
        undefined,
        [{ path: 'nextRequestAt', message: metaReq.nextAt?.toISOString() ?? '' }],
        metaReq.nextAt
          ? {
              retryAfterSec: Math.max(
                0,
                Math.ceil((metaReq.nextAt.getTime() - now.getTime()) / 1000),
              ),
            }
          : {},
      );
    }
    const conversation: ConversationDoc =
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
    const calling = channel.calling ?? defaultCalling();
    const inWindow = isWindowOpen(conversation, now);
    let kind: 'interactive' | 'template';
    let messageId: Types.ObjectId;
    if (inWindow) {
      kind = 'interactive';
      const sent = await sendMessage(deps.inbox, actor, conversation._id.toString(), {
        type: 'call_permission_request',
        body: input.body?.trim() || calling.permissionRequestBody,
        clientId: randomUUID(),
      });
      messageId = sent.message._id;
    } else {
      kind = 'template';
      const template = await permissionTemplate(channel);
      if (!template) throw new AppError('WHATSAPP_CALL_PERMISSION_TEMPLATE_MISSING');
      const sent = await sendMessage(deps.inbox, actor, conversation._id.toString(), {
        type: 'template',
        templateId: template._id.toString(),
        clientId: randomUUID(),
      });
      messageId = sent.message._id;
    }
    await forgetMeta(channel._id, waId);
    const updated = await upsertRow(actor.accountId, channel._id, contact._id, {
      $set: {
        status: 'requested',
        expiresAt: null,
        lastRequest: { messageId, kind, at: now, by: actor.userId },
        'requests.day': [...ours.day, now],
        'requests.week': [...ours.week, now],
      },
      $push: historyPush({ status: 'requested', at: now, source: 'business' }),
    });
    await recordAudit({
      accountId: actor.accountId,
      actor: {
        type: actor.type,
        id: actor.id ?? actor.userId,
        impersonatorId: actor.impersonatorId ?? null,
      },
      action: 'whatsapp.call_permission_requested',
      target: { type: 'contact', id: contact._id.toString() },
      meta: { channelId: channel._id.toString(), kind },
      ip: actor.ip ?? null,
    });
    return { permission: updated, messageId: messageId.toString(), kind };
  };

  const bell = async (
    row: WhatsAppCallPermissionDoc,
    channel: WhatsAppChannelDoc,
    type:
      | 'whatsapp.call_permission_granted'
      | 'whatsapp.call_permission_declined'
      | 'whatsapp.call_permission_revoked',
    body: string,
  ) => {
    try {
      const spec = CALLING_NOTIFICATIONS[type];
      const ids = new Set<string>();
      if (row.lastRequest?.by) ids.add(row.lastRequest.by.toString());
      if (spec.audience === 'requester_and_managers') {
        for (const u of await usersWithPermission(row.accountId, 'templates.manage'))
          ids.add(u.userId.toString());
      }
      if (!ids.size) return;
      const contact = await ContactModel.findById(row.contactId)
        .select({ phoneE164: 1, whatsapp: 1 })
        .lean<ContactDoc>();
      const conversation = contact
        ? await ConversationModel.findOne({
            accountId: row.accountId,
            channelId: channel._id,
            waId: waIdOf(contact),
          })
            .select({ _id: 1 })
            .lean<{ _id: Types.ObjectId }>()
        : null;
      await notify({
        accountId: row.accountId,
        userIds: [...ids].map((id) => new Types.ObjectId(id)),
        type,
        title: spec.title,
        body,
        link: spec.link(conversation?._id.toString()),
      });
    } catch (err) {
      getLogger().error({ err, type }, 'whatsapp calling: permission bell failed');
    }
  };

  const audit = (
    row: WhatsAppCallPermissionDoc,
    action:
      | 'whatsapp.call_permission_granted'
      | 'whatsapp.call_permission_declined'
      | 'whatsapp.call_permission_revoked',
    meta: Record<string, unknown>,
  ) =>
    recordAudit({
      accountId: row.accountId,
      actor: { type: 'system' },
      action,
      target: { type: 'contact', id: row.contactId.toString() },
      meta: { channelId: row.channelId.toString(), ...meta },
    });

  /**
   * `call_permission_reply` (inbox hook): accept → temporary (Meta's expiry) / permanent,
   * reject → declined; `automatic` (the customer called, callback on) → source `callback`.
   * The request message is marked answered.
   */
  const onReply = async (input: {
    channel: WhatsAppChannelDoc;
    contactId: Types.ObjectId;
    reply: {
      response: 'accept' | 'reject';
      isPermanent: boolean;
      expiresAt: Date | null;
      source: string | null;
    };
    contextId: string | null;
    at: Date;
  }): Promise<WhatsAppCallPermissionDoc> => {
    const { channel, reply, at } = input;
    const automatic = reply.source === 'automatic';
    const source = automatic ? 'callback' : 'request_reply';
    const status: CallPermissionStatus =
      reply.response === 'reject' ? 'declined' : reply.isPermanent ? 'permanent' : 'temporary';
    const expiresAt =
      status === 'temporary'
        ? (reply.expiresAt ??
          new Date(at.getTime() + WHATSAPP_CALL_LIMITS.temporaryPermissionDays * DAY_MS))
        : null;
    const contact = await ContactModel.findById(input.contactId)
      .select({ phoneE164: 1, whatsapp: 1 })
      .lean<ContactDoc>();
    if (contact) await forgetMeta(channel._id, waIdOf(contact));
    const row = await upsertRow(channel.accountId, channel._id, input.contactId, {
      $set: { status, expiresAt, source, unansweredStreak: 0 },
      $push: historyPush({ status, at, source }),
    });
    if (input.contextId && !automatic) {
      await MessageModel.updateOne(
        {
          accountId: channel.accountId,
          channelId: channel._id,
          waMessageId: input.contextId,
          'interactive.kind': 'call_permission_request',
        },
        {
          $set: {
            'interactive.callPermission': {
              response: reply.response,
              isPermanent: reply.isPermanent,
              expiresAt,
              source: reply.source,
              requestWaMessageId: input.contextId,
            },
          },
        },
      );
    }
    const granted = status !== 'declined';
    await audit(
      row,
      granted ? 'whatsapp.call_permission_granted' : 'whatsapp.call_permission_declined',
      {
        permanent: status === 'permanent',
        source,
      },
    );
    await bell(
      row,
      channel,
      granted ? 'whatsapp.call_permission_granted' : 'whatsapp.call_permission_declined',
      granted
        ? `A customer allowed WhatsApp calls on ${numberName(channel)}${status === 'permanent' ? ' (always)' : ' for 7 days'}.`
        : `A customer declined WhatsApp calls on ${numberName(channel)}.`,
    );
    return row;
  };

  /**
   * After a business-initiated call (T12.6): answered → the streak resets; not answered →
   * +1 (2 → `nudge`, 4 → `revoked` like Meta).
   */
  const onCallOutcome = async (input: {
    accountId: Types.ObjectId;
    channelId: Types.ObjectId;
    contactId: Types.ObjectId;
    answered: boolean;
  }): Promise<'ok' | 'nudge' | 'revoked'> => {
    const now = nowOf(ctx);
    const channel = await loadChannel(input.accountId, input.channelId);
    if (input.answered) {
      await upsertRow(input.accountId, channel._id, input.contactId, {
        $set: { unansweredStreak: 0, 'requests.day': [], 'requests.week': [] },
        $inc: { connectedCallsLast24h: 1 },
      });
      return 'ok';
    }
    const row = await upsertRow(input.accountId, channel._id, input.contactId, {
      $inc: { unansweredStreak: 1 },
    });
    if (row.unansweredStreak >= WHATSAPP_CALL_LIMITS.unansweredRevoke && row.status !== 'revoked') {
      const revoked = await upsertRow(input.accountId, channel._id, input.contactId, {
        $set: { status: 'revoked', expiresAt: null },
        $push: historyPush({ status: 'revoked', at: now, source: 'meta' }),
      });
      const contact = await ContactModel.findById(input.contactId)
        .select({ phoneE164: 1, whatsapp: 1 })
        .lean<ContactDoc>();
      if (contact) await forgetMeta(channel._id, waIdOf(contact));
      await audit(revoked, 'whatsapp.call_permission_revoked', {
        reason: 'unanswered',
        unanswered: revoked.unansweredStreak,
      });
      await bell(
        revoked,
        channel,
        'whatsapp.call_permission_revoked',
        `A customer missed ${String(revoked.unansweredStreak)} calls in a row on ${numberName(channel)} — WhatsApp removed the call permission.`,
      );
      return 'revoked';
    }
    return row.unansweredStreak >= WHATSAPP_CALL_LIMITS.unansweredNudge ? 'nudge' : 'ok';
  };

  /** Hourly: temporary permissions past their time → `expired` (Meta sends no webhook). */
  const sweep = async (): Promise<{ expired: number }> => {
    const now = nowOf(ctx);
    const due = await WhatsAppCallPermissionModel.find({
      status: 'temporary',
      expiresAt: { $lte: now },
    })
      .limit(5_000)
      .lean<WhatsAppCallPermissionDoc[]>();
    let expired = 0;
    for (const row of due) {
      const updated = await WhatsAppCallPermissionModel.findOneAndUpdate(
        { _id: row._id, status: 'temporary' },
        {
          $set: { status: 'expired' },
          $push: historyPush({ status: 'expired', at: now, source: 'sweep' }),
        },
        { returnDocument: 'after' },
      ).lean<WhatsAppCallPermissionDoc>();
      if (!updated) continue;
      expired += 1;
      emitUpdated(updated);
    }
    return { expired };
  };

  return {
    statusFor,
    request,
    onReply,
    onCallOutcome,
    sweep,
    metaPermission,
    loadRow,
    valid,
  };
};

export type CallPermissionsService = ReturnType<typeof createCallPermissions>;
