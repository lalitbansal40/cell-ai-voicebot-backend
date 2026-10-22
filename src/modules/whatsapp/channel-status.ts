import type { Types, UpdateQuery } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { getEmail, type EmailTemplateKey } from '../../core/email';
import { notifyAccount } from '../../core/realtime/notify';
import { AccountModel } from '../../db/models/account.model';
import type { NotificationType } from '../../db/models/notification.model';
import {
  WhatsAppChannelModel,
  type WaChannelStatus,
  type WaStatusReason,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { notify, usersWithPermission } from '../notifications/notifications.service';

import { channelEvent } from './channel-json';
import { nowOf, phoneLast4, type WhatsAppContext } from './context';

/** Who changed a channel: a user (maybe impersonated / a superadmin) or the system (jobs, webhooks). */
export interface WaActor {
  type: 'user' | 'system';
  id: Types.ObjectId | null;
  impersonatorId?: Types.ObjectId | null;
  /** A superadmin acting from the platform account. */
  platform?: boolean;
  ip?: string | null;
}

export const SYSTEM_ACTOR: WaActor = { type: 'system', id: null };

export const NUMBERS_LINK = '/whatsapp/numbers';

/** Audit with the standard channel meta (never tokens, PINs, codes or customer data). */
export const auditChannel = (
  channel: WhatsAppChannelDoc,
  action: AuditAction,
  actor: WaActor,
  meta: Record<string, unknown> = {},
  accountId: Types.ObjectId = channel.accountId,
): Promise<void> =>
  recordAudit({
    accountId,
    actor: {
      type: actor.type,
      id: actor.id,
      impersonatorId: actor.impersonatorId ?? null,
      platform: actor.platform ?? false,
    },
    action,
    target: { type: 'whatsapp_channel', id: channel._id.toString() },
    meta: {
      channelId: channel._id.toString(),
      mode: channel.mode,
      phoneLast4: phoneLast4(channel.displayPhoneNumber),
      wabaId: channel.wabaId,
      status: channel.status,
      ...meta,
    },
    ip: actor.ip ?? null,
  });

/** `whatsapp.channel.updated` to the account (fire and forget). */
export const emitChannelUpdated = (channel: WhatsAppChannelDoc): void => {
  notifyAccount(channel.accountId.toString(), 'whatsapp.channel.updated', channelEvent(channel));
};

const EMAIL_FOR: Partial<Record<NotificationType, EmailTemplateKey>> = {
  'whatsapp.channel_needs_reconnect': 'whatsapp.needs_reconnect',
  'whatsapp.channel_restricted': 'whatsapp.restricted',
  'whatsapp.channel_disconnected_by_admin': 'whatsapp.admin_disconnected',
};

export const numberName = (channel: WhatsAppChannelDoc): string => {
  const last4 = phoneLast4(channel.displayPhoneNumber);
  return last4 ? `"${channel.label}" (…${last4})` : `"${channel.label}"`;
};

/**
 * In-app notification to the account's owners / admins (`whatsapp.manage`) and,
 * for the three serious types, an email (once per transition: dedupe key). Never throws.
 */
export const notifyChannel = async (
  ctx: Pick<WhatsAppContext, 'env' | 'now'>,
  channel: WhatsAppChannelDoc,
  type: NotificationType,
  title: string,
  body: string,
  reason = '',
): Promise<void> => {
  try {
    const recipients = await usersWithPermission(channel.accountId, 'whatsapp.manage');
    await notify({
      accountId: channel.accountId,
      userIds: recipients.map((r) => r.userId),
      type,
      title,
      body,
      link: NUMBERS_LINK,
    });
    const template = EMAIL_FOR[type];
    if (!template || !recipients.length) return;
    const account = await AccountModel.findById(channel.accountId)
      .select({ name: 1 })
      .lean<{ name: string }>();
    const vars = {
      accountName: account?.name ?? 'Your account',
      label: channel.label,
      phoneLast4: phoneLast4(channel.displayPhoneNumber),
      reason,
      numbersUrl: `${ctx.env.FRONTEND_URL.replace(/\/+$/, '')}${NUMBERS_LINK}`,
    };
    const at = nowOf(ctx).getTime();
    for (const r of recipients) {
      await getEmail().enqueue(template, r.email, vars, {
        dedupeKey: `wa-${type}-${channel._id.toString()}-${String(at)}-${r.userId.toString()}`,
      });
    }
  } catch (err) {
    getLogger().error(
      { err, type, channelId: channel._id.toString() },
      'whatsapp: notification failed',
    );
  }
};

const TRANSITION_NOTICES: Partial<
  Record<WaChannelStatus, { type: NotificationType; title: string }>
> = {
  needs_reconnect: {
    type: 'whatsapp.channel_needs_reconnect',
    title: 'Reconnect your WhatsApp number',
  },
  restricted: { type: 'whatsapp.channel_restricted', title: 'WhatsApp number restricted by Meta' },
};

/**
 * Moves a channel to `to` (or just updates its reason / fields when the status is
 * unchanged): history (last 50), WS event, audit for system actors, owner / admin
 * notifications once per transition. Returns the updated channel.
 */
export const transition = async (
  ctx: Pick<WhatsAppContext, 'env' | 'now'>,
  channel: WhatsAppChannelDoc,
  to: WaChannelStatus,
  reason: WaStatusReason | null,
  actor: WaActor,
  extra: Record<string, unknown> = {},
): Promise<WhatsAppChannelDoc> => {
  const from = channel.status;
  const changed = from !== to;
  const update: UpdateQuery<WhatsAppChannelDoc> = {
    $set: { ...extra, status: to, statusReason: reason },
  };
  if (changed) {
    update.$push = {
      history: {
        $each: [{ status: to, reason: reason?.message ?? null, at: nowOf(ctx), by: actor.id }],
        $slice: -WHATSAPP_LIMITS.historyMax,
      },
    };
  }
  const updated = await WhatsAppChannelModel.findOneAndUpdate({ _id: channel._id }, update, {
    returnDocument: 'after',
  }).lean<WhatsAppChannelDoc>();
  if (!updated) return channel;
  emitChannelUpdated(updated);
  if (!changed) return updated;
  if (actor.type === 'system') {
    await auditChannel(updated, 'whatsapp.channel_status_changed', actor, {
      from,
      reasonCode: reason?.code ?? null,
    });
  }
  const notice = TRANSITION_NOTICES[to];
  if (notice) {
    const why = reason?.message ?? '';
    await notifyChannel(
      ctx,
      updated,
      notice.type,
      notice.title,
      `${numberName(updated)}: ${why}`.slice(0, 500),
      why.replace(/\.$/, ''),
    );
  }
  return updated;
};

export const TOKEN_INVALID_REASON: WaStatusReason = {
  code: 'token_invalid',
  message: 'Meta access was removed or has expired — reconnect the number.',
  step: null,
};

/** Every Graph `190` (token gone) for a channel ends here. */
export const markNeedsReconnect = (
  ctx: Pick<WhatsAppContext, 'env' | 'now'>,
  channel: WhatsAppChannelDoc,
  reason: WaStatusReason = TOKEN_INVALID_REASON,
  actor: WaActor = SYSTEM_ACTOR,
): Promise<WhatsAppChannelDoc> => transition(ctx, channel, 'needs_reconnect', reason, actor);

/**
 * Notifications for detail changes Meta reports (sync / health pass): quality turned
 * red, display name approved / rejected — once per change (compares before / after).
 */
export const notifyDetailChanges = async (
  ctx: Pick<WhatsAppContext, 'env' | 'now'>,
  before: WhatsAppChannelDoc,
  after: WhatsAppChannelDoc,
): Promise<void> => {
  if (after.qualityRating === 'RED' && before.qualityRating !== 'RED') {
    await notifyChannel(
      ctx,
      after,
      'whatsapp.quality_low',
      'WhatsApp number quality is low',
      `${numberName(after)}: Meta rated its quality red — fewer messages may be delivered. Check recent messages for complaints.`,
    );
  }
  if (after.nameStatus === 'APPROVED' && before.nameStatus && before.nameStatus !== 'APPROVED') {
    await notifyChannel(
      ctx,
      after,
      'whatsapp.name_approved',
      'WhatsApp display name approved',
      `${numberName(after)}: Meta approved the display name "${after.verifiedName ?? ''}".`,
    );
  }
  const rejected = (s: string | null | undefined) => s === 'DECLINED' || s === 'REJECTED';
  if (rejected(after.newNameStatus) && !rejected(before.newNameStatus)) {
    await notifyChannel(
      ctx,
      after,
      'whatsapp.name_rejected',
      'WhatsApp display name rejected',
      `${numberName(after)}: Meta rejected the new display name. Change it in WhatsApp Manager.`,
    );
  }
};
