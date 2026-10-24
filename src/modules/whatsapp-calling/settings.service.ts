import { Types } from 'mongoose';

import { getEmail } from '../../core/email';
import {
  isCallingRestrictionType,
  type MetaCallingSettings,
  type MetaCallingSettingsUpdate,
} from '../../core/meta';
import { AccountModel } from '../../db/models/account.model';
import {
  callHoursProblems,
  defaultCalling,
  WhatsAppChannelModel,
  type CallHours,
  type WaCalling,
  type WaCallingRestriction,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import {
  AppError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { notify, usersWithPermission } from '../notifications/notifications.service';
import {
  auditChannel,
  emitChannelUpdated,
  numberName,
  NUMBERS_LINK,
  SYSTEM_ACTOR,
  type WaActor,
} from '../whatsapp/channel-status';
import { nowOf, phoneLast4, type WhatsAppContext } from '../whatsapp/context';

import { callingUnavailableReason } from './availability';
import type { CallingSettingsPatchInput } from './calling.schema';
import { withCallErrors } from './errors';
import { callingView, type CallingView } from './json';
import { CALLING_NOTIFICATIONS } from './notification-types';
import { programProblems } from './program';

/**
 * WhatsApp calling settings of a number (PHASE_12_PROMPT T12.5): ours (routing, ring
 * list, request text) + Meta's (status, call icon, call hours, callback permission,
 * restrictions). Meta's fields are written to Meta first, then stored; reads merge
 * the last Meta sync. Never logs tokens or customer data.
 */
export interface CallingDeps {
  ctx: WhatsAppContext;
  /** Opened business token of a usable channel (`whatsapp.service.getChannelToken`). */
  token: (
    channelId: Types.ObjectId | string,
  ) => Promise<{ channel: WhatsAppChannelDoc; token: string }>;
}

const callingOf = (channel: WhatsAppChannelDoc): WaCalling => channel.calling ?? defaultCalling();

const load = async (accountId: Types.ObjectId, channelId: string): Promise<WhatsAppChannelDoc> => {
  const channel = await WhatsAppChannelModel.findOne({
    _id: new Types.ObjectId(channelId),
    accountId,
  }).lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  return channel;
};

const save = async (channelId: Types.ObjectId, set: Record<string, unknown>) => {
  const updated = await WhatsAppChannelModel.findOneAndUpdate(
    { _id: channelId },
    { $set: set },
    { returnDocument: 'after', runValidators: true },
  ).lean<WhatsAppChannelDoc>();
  if (!updated) throw new NotFoundError('WhatsApp number not found');
  emitChannelUpdated(updated);
  return updated;
};

/** Today (`YYYY-MM-DD`) in a time zone — holidays must not lie in the past. */
const todayIn = (tz: string, now: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

/** Our status from Meta's (a number that can't call stays `unavailable`). */
const ourStatus = (meta: string | null, unavailable: boolean, fallback: WaCalling['status']) =>
  unavailable
    ? 'unavailable'
    : meta === 'ENABLED'
      ? 'enabled'
      : meta === 'DISABLED'
        ? 'disabled'
        : fallback;

/** Meta's restrictions replace the calling ones we had (Meta's GET is the truth). */
const mergeRestrictions = (meta: MetaCallingSettings): WaCallingRestriction[] =>
  meta.restrictions.map((r) => ({ type: r.type, reason: r.reason, expiresAt: r.expiresAt }));

export const createCallingSettings = (deps: CallingDeps) => {
  const { ctx } = deps;

  const getCalling = async (accountId: Types.ObjectId, channelId: string): Promise<CallingView> =>
    callingView(await load(accountId, channelId), nowOf(ctx));

  /**
   * Meta's settings → our row (status, icon, hours, callback, restrictions). `throwOnError`
   * for the manual sync; jobs / webhooks store `lastError` and carry on.
   */
  const syncCalling = async (
    channel: WhatsAppChannelDoc,
    options: { throwOnError?: boolean } = {},
  ): Promise<WhatsAppChannelDoc> => {
    const now = nowOf(ctx);
    const calling = callingOf(channel);
    const unavailableReason = callingUnavailableReason(channel);
    let meta: MetaCallingSettings;
    try {
      const { token } = await deps.token(channel._id);
      meta = await withCallErrors(() =>
        ctx.meta.getPhoneSettings(token, channel.phoneNumberId ?? ''),
      );
    } catch (err) {
      getLogger().warn(
        { channelId: channel._id.toString(), errName: (err as Error).name },
        'whatsapp calling: settings sync failed',
      );
      await WhatsAppChannelModel.updateOne(
        { _id: channel._id },
        { $set: { 'calling.lastError': 'Could not read the call settings from WhatsApp' } },
      );
      if (options.throwOnError) throw err;
      return channel;
    }
    const hours: CallHours = meta.callHours
      ? {
          enabled: meta.callHours.status === 'ENABLED',
          timezone: meta.callHours.timezoneId,
          weekly: meta.callHours.weekly,
          holidays: meta.callHours.holidays,
        }
      : calling.callHours;
    return save(channel._id, {
      'calling.status': ourStatus(meta.status, unavailableReason !== null, calling.status),
      'calling.unavailableReason': unavailableReason,
      'calling.callIconVisibility':
        meta.callIconVisibility === 'DISABLE_ALL' ? 'DISABLE_ALL' : 'DEFAULT',
      'calling.iconCountries': meta.iconCountries,
      'calling.callHours': callHoursProblems(hours).length ? calling.callHours : hours,
      'calling.callbackPermission': meta.callbackPermissionStatus === 'ENABLED',
      'calling.restrictions': mergeRestrictions(meta),
      'calling.syncedAt': now,
      'calling.lastError': null,
    });
  };

  const validate = async (
    channel: WhatsAppChannelDoc,
    patch: CallingSettingsPatchInput,
    now: Date,
  ): Promise<void> => {
    const problems: ErrorDetail[] = [];
    const calling = callingOf(channel);
    if (patch.callHours) {
      const h = patch.callHours;
      for (const message of callHoursProblems(h)) problems.push({ path: 'callHours', message });
      if (h.enabled && h.weekly.length === 0) {
        problems.push({ path: 'callHours.weekly', message: 'Add at least one time range' });
      }
      const today = todayIn(h.timezone, now);
      h.holidays.forEach((d, i) => {
        if (d.date < today) {
          problems.push({
            path: `callHours.holidays.${String(i)}.date`,
            message: 'Must be today or later',
          });
        }
      });
    }
    const route = patch.inbound?.route ?? calling.inbound.route;
    const program =
      patch.inbound?.aiProgram !== undefined ? patch.inbound.aiProgram : calling.inbound.aiProgram;
    const routeChanges =
      patch.inbound?.route !== undefined || patch.inbound?.aiProgram !== undefined;
    if (routeChanges && route !== 'team') {
      problems.push(...(await programProblems(channel.accountId, program, 'inbound.aiProgram')));
    }
    const ring = patch.inbound?.ringUserIds;
    if (ring) {
      const eligible = new Set(
        (await usersWithPermission(channel.accountId, 'calls.answer')).map((u) =>
          u.userId.toString(),
        ),
      );
      ring.forEach((id, i) => {
        if (!eligible.has(id)) {
          problems.push({
            path: `inbound.ringUserIds.${String(i)}`,
            message: 'Not a team member who can answer calls',
          });
        }
      });
      if (new Set(ring).size !== ring.length) {
        problems.push({ path: 'inbound.ringUserIds', message: 'Listed twice' });
      }
    }
    if (problems.length) throw new ValidationError(problems);
  };

  /** The Meta part of a patch (only fields that change Meta's settings). */
  const metaUpdate = (
    calling: WaCalling,
    patch: CallingSettingsPatchInput,
  ): MetaCallingSettingsUpdate | null => {
    const out: MetaCallingSettingsUpdate = {};
    if (patch.status && patch.status !== calling.status) {
      out.status = patch.status === 'enabled' ? 'ENABLED' : 'DISABLED';
    }
    if (patch.callIconVisibility && patch.callIconVisibility !== calling.callIconVisibility) {
      out.callIconVisibility = patch.callIconVisibility;
    }
    if (patch.iconCountries) out.iconCountries = [...new Set(patch.iconCountries)];
    if (patch.callHours) {
      out.callHours = {
        status: patch.callHours.enabled ? 'ENABLED' : 'DISABLED',
        timezoneId: patch.callHours.timezone,
        weekly: patch.callHours.weekly,
        holidays: patch.callHours.holidays,
      };
    }
    if (
      patch.callbackPermission !== undefined &&
      patch.callbackPermission !== calling.callbackPermission
    ) {
      out.callbackPermissionStatus = patch.callbackPermission ? 'ENABLED' : 'DISABLED';
    }
    return Object.keys(out).length ? out : null;
  };

  const updateCalling = async (
    actor: WaActor,
    accountId: Types.ObjectId,
    channelId: string,
    patch: CallingSettingsPatchInput,
  ): Promise<CallingView> => {
    const now = nowOf(ctx);
    const channel = await load(accountId, channelId);
    const calling = callingOf(channel);
    const unavailableReason = callingUnavailableReason(channel);
    if (patch.status === 'enabled' && unavailableReason) {
      throw new AppError('WHATSAPP_CALLING_UNAVAILABLE', undefined, [
        { path: 'status', message: unavailableReason },
      ]);
    }
    await validate(channel, patch, now);
    const forMeta = metaUpdate(calling, patch);
    if (forMeta) {
      const { token } = await deps.token(channel._id);
      await withCallErrors(() =>
        ctx.meta.updateCallingSettings(token, channel.phoneNumberId ?? '', forMeta),
      );
    }
    const set: Record<string, unknown> = { 'calling.unavailableReason': unavailableReason };
    if (patch.status) set['calling.status'] = unavailableReason ? 'unavailable' : patch.status;
    if (patch.callIconVisibility) set['calling.callIconVisibility'] = patch.callIconVisibility;
    if (patch.iconCountries) set['calling.iconCountries'] = [...new Set(patch.iconCountries)];
    if (patch.callHours) set['calling.callHours'] = patch.callHours;
    if (patch.callbackPermission !== undefined) {
      set['calling.callbackPermission'] = patch.callbackPermission;
    }
    if (patch.permissionRequestBody)
      set['calling.permissionRequestBody'] = patch.permissionRequestBody;
    if (patch.inbound?.route) set['calling.inbound.route'] = patch.inbound.route;
    if (patch.inbound?.aiProgram !== undefined) {
      set['calling.inbound.aiProgram'] = patch.inbound.aiProgram
        ? { kind: patch.inbound.aiProgram.kind, id: new Types.ObjectId(patch.inbound.aiProgram.id) }
        : null;
    }
    if (patch.inbound?.ringTimeoutSec !== undefined) {
      set['calling.inbound.ringTimeoutSec'] = patch.inbound.ringTimeoutSec;
    }
    if (patch.inbound?.ringUserIds !== undefined) {
      set['calling.inbound.ringUserIds'] = patch.inbound.ringUserIds
        ? patch.inbound.ringUserIds.map((id) => new Types.ObjectId(id))
        : null;
    }
    if (forMeta) set['calling.lastError'] = null;
    const updated = await save(channel._id, set);
    const fields = Object.keys(patch).flatMap((k) =>
      k === 'inbound' ? Object.keys(patch.inbound ?? {}).map((f) => `inbound.${f}`) : [k],
    );
    await auditChannel(updated, 'whatsapp.calling_settings_updated', actor, {
      fields,
      callingStatus: callingOf(updated).status,
    });
    return callingView(updated, now);
  };

  /** Manual sync (route) — Meta errors are mapped and thrown. */
  const syncNow = async (accountId: Types.ObjectId, channelId: string): Promise<CallingView> => {
    const channel = await load(accountId, channelId);
    return callingView(await syncCalling(channel, { throwOnError: true }), nowOf(ctx));
  };

  /** Owners / admins get the bell (+ e-mail) when Meta pauses calling on the number. */
  const notifyRestricted = async (channel: WhatsAppChannelDoc, r: WaCallingRestriction) => {
    const spec = CALLING_NOTIFICATIONS['whatsapp.calling_restricted'];
    const until = r.expiresAt
      ? ` until ${r.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
      : '';
    const reason = r.type.startsWith('RESTRICTED_BUSINESS')
      ? `business calls are paused${until}`
      : `customer calls are limited${until}`;
    try {
      const recipients = await usersWithPermission(channel.accountId, 'whatsapp.calling.manage');
      await notify({
        accountId: channel.accountId,
        userIds: recipients.map((u) => u.userId),
        type: 'whatsapp.calling_restricted',
        title: spec.title,
        body: `WhatsApp paused calling on ${numberName(channel)}: ${reason}.`,
        link: NUMBERS_LINK,
      });
      if (!recipients.length) return;
      const account = await AccountModel.findById(channel.accountId)
        .select({ name: 1 })
        .lean<{ name: string }>();
      for (const u of recipients) {
        await getEmail().enqueue(
          'whatsapp.calling_restricted',
          u.email,
          {
            accountName: account?.name ?? 'Your account',
            label: channel.label,
            phoneLast4: phoneLast4(channel.displayPhoneNumber),
            reason,
            numbersUrl: `${ctx.env.FRONTEND_URL.replace(/\/+$/, '')}${NUMBERS_LINK}`,
          },
          {
            dedupeKey: `wa-calling-restricted-${channel._id.toString()}-${r.type}-${String(r.expiresAt?.getTime() ?? 0)}-${u.userId.toString()}`,
          },
        );
      }
    } catch (err) {
      getLogger().error(
        { err, channelId: channel._id.toString() },
        'whatsapp calling: notification failed',
      );
    }
  };

  /**
   * Calling `account_update` events (true = handled here, so Phase 9 doesn't restrict
   * the whole number): a restriction is stored + bell + audit; a lifted one is removed;
   * warnings (violations) are audited.
   */
  const onAccountUpdate = async (
    channel: WhatsAppChannelDoc,
    v: {
      event: string;
      restriction_info?: { restriction_type: string; expiration?: number | null }[] | null;
      violation_info?: { violation_type?: string | null } | null;
    },
  ): Promise<boolean> => {
    const calling = (v.restriction_info ?? []).filter((r) =>
      isCallingRestrictionType(r.restriction_type),
    );
    const violation = v.violation_info?.violation_type ?? null;
    const isCallingViolation = Boolean(violation?.includes('CALL'));
    if (!calling.length && !isCallingViolation) return false;
    if (v.event === 'ACCOUNT_VIOLATION' || !calling.length) {
      await auditChannel(channel, 'whatsapp.calling_restricted', SYSTEM_ACTOR, {
        warning: violation,
      });
      return true;
    }
    const current = callingOf(channel).restrictions.filter(
      (r) => !calling.some((c) => c.restriction_type === r.type),
    );
    const added = calling.map((r) => ({
      type: r.restriction_type,
      reason: null,
      expiresAt: r.expiration ? new Date(r.expiration * 1000) : null,
    }));
    const updated = await save(channel._id, { 'calling.restrictions': [...current, ...added] });
    for (const r of added) {
      await auditChannel(updated, 'whatsapp.calling_restricted', SYSTEM_ACTOR, {
        type: r.type,
        until: r.expiresAt?.toISOString() ?? null,
      });
      await notifyRestricted(updated, r);
    }
    return true;
  };

  /** `account_settings_update`: Meta changed the call settings → read them again. */
  const onSettingsWebhook = async (channel: WhatsAppChannelDoc): Promise<void> => {
    await syncCalling(channel);
  };

  /** Daily job (04:20 IST): every connected number that may call. */
  const syncAll = async (): Promise<{ synced: number }> => {
    const channels = await WhatsAppChannelModel.find({
      status: { $in: ['connected', 'action_needed'] },
      phoneNumberId: { $type: 'string' },
      mode: 'cloud_api',
    })
      .limit(5_000)
      .lean<WhatsAppChannelDoc[]>();
    let synced = 0;
    for (const c of channels) {
      const after = await syncCalling(c);
      if (after !== c) synced += 1;
    }
    return { synced };
  };

  return {
    getCalling,
    updateCalling,
    syncCalling,
    syncNow,
    onAccountUpdate,
    onSettingsWebhook,
    syncAll,
  };
};

export type CallingSettingsService = ReturnType<typeof createCallingSettings>;
