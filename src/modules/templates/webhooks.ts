import type { z } from 'zod';

import { TEMPLATE_WEBHOOK_VALUE_SCHEMAS, type TemplateWebhookField } from '../../core/meta';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_QUALITY,
  TEMPLATE_STATUSES,
  WhatsAppTemplateModel,
  type TemplateCategory,
  type TemplateQuality,
  type TemplateStatus,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { getLogger } from '../../shared/logger';
import { SYSTEM_ACTOR } from '../whatsapp/channel-status';
import { WebhookSchemaError, type TemplateHooks } from '../whatsapp/webhook-handlers';

import type { TemplateContext } from './context';
import { contactsForWaId, setMarketingPreference } from './marketing';
import { auditTemplate, emitTemplateUpdated, notifyTemplate, reasonText } from './notify';
import { historyPush } from './template.service';

const parse = <F extends TemplateWebhookField>(
  field: F,
  value: unknown,
): z.infer<(typeof TEMPLATE_WEBHOOK_VALUE_SCHEMAS)[F]> => {
  const parsed = TEMPLATE_WEBHOOK_VALUE_SCHEMAS[field].safeParse(value);
  if (!parsed.success) throw new WebhookSchemaError(field);
  return parsed.data as z.infer<(typeof TEMPLATE_WEBHOOK_VALUE_SCHEMAS)[F]>;
};

/** Meta status events → our statuses (`LOCKED` changes no status, only the reason). */
const EVENT_STATUS: Record<string, TemplateStatus | null> = {
  REINSTATED: 'APPROVED',
  UNARCHIVED: 'APPROVED',
  UNPAUSED: 'APPROVED',
  LOCKED: null,
};

const statusOf = (event: string): TemplateStatus | null => {
  const upper = event.toUpperCase();
  if (upper in EVENT_STATUS) return EVENT_STATUS[upper] ?? null;
  return (TEMPLATE_STATUSES as readonly string[]).includes(upper)
    ? (upper as TemplateStatus)
    : null;
};

/** Meta pauses: 3 h, then 6 h; a third pause disables the template. */
const PAUSE_MS: Record<string, number> = {
  FIRST_PAUSE: 3 * 3_600_000,
  SECOND_PAUSE: 6 * 3_600_000,
};

const asCategory = (c: string | null | undefined): TemplateCategory | null =>
  c && (TEMPLATE_CATEGORIES as readonly string[]).includes(c.toUpperCase())
    ? (c.toUpperCase() as TemplateCategory)
    : null;

/** The template a WABA event names, if we have it (else: queue a sync). */
const findTemplate = async (
  tx: TemplateContext,
  channel: WhatsAppChannelDoc,
  metaTemplateId: string,
): Promise<WhatsAppTemplateDoc | null> => {
  const t = await WhatsAppTemplateModel.findOne({
    accountId: channel.accountId,
    wabaId: channel.wabaId,
    metaTemplateId,
  }).lean<WhatsAppTemplateDoc>();
  if (!t) await tx.jobs.enqueueSync(channel._id.toString(), 'webhook');
  return t;
};

/** Events older than what the row already shows (a newer webhook or sync) are ignored. */
const isStale = (t: WhatsAppTemplateDoc, at: Date) =>
  t.lastEventAt !== null && at.getTime() < t.lastEventAt.getTime();

const NOTICE: Partial<
  Record<
    TemplateStatus,
    'template.approved' | 'template.rejected' | 'template.paused' | 'template.disabled'
  >
> = {
  APPROVED: 'template.approved',
  REJECTED: 'template.rejected',
  PAUSED: 'template.paused',
  DISABLED: 'template.disabled',
};

const statusUpdate = async (
  tx: TemplateContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
  at: Date,
): Promise<void> => {
  const v = parse('message_template_status_update', value);
  const t = await findTemplate(tx, channel, v.message_template_id);
  if (!t || isStale(t, at)) return;
  const status = statusOf(v.event) ?? t.status;
  const title = v.other_info?.title ?? null;
  const reasonCode =
    v.reason && v.reason !== 'NONE'
      ? v.reason
      : (title ?? (v.event === 'LOCKED' ? 'LOCKED' : null));
  const same = status === t.status && (t.statusReason?.reason ?? null) === reasonCode;
  if (same && t.lastEventAt?.getTime() === at.getTime()) return;
  const category = asCategory(v.message_template_category);
  const pausedUntil =
    status === 'PAUSED' && title && PAUSE_MS[title]
      ? new Date(at.getTime() + PAUSE_MS[title])
      : null;
  const updated = await WhatsAppTemplateModel.findOneAndUpdate(
    { _id: t._id },
    {
      $set: {
        status,
        statusReason: reasonCode
          ? {
              reason: reasonCode,
              title: title ?? v.rejection_info?.reason ?? null,
              description: v.other_info?.description ?? v.rejection_info?.recommendation ?? null,
            }
          : null,
        pausedUntil,
        ...(category && category !== t.category ? { category, previousCategory: t.category } : {}),
        ...(status === 'DELETED' ? { deletedAt: at } : {}),
        lastEventAt: at,
      },
      ...(status !== t.status
        ? { $push: historyPush({ status, reason: reasonCode, at, source: 'webhook' }) }
        : {}),
    },
    { returnDocument: 'after' },
  ).lean<WhatsAppTemplateDoc>();
  if (!updated) return;
  emitTemplateUpdated(updated);
  if (status === t.status) return;
  await auditTemplate(updated, 'template.status_changed', SYSTEM_ACTOR, {
    from: t.status,
    to: status,
    reasonCode,
  });
  const notice = NOTICE[status];
  if (notice) {
    const detail =
      status === 'APPROVED'
        ? null
        : status === 'REJECTED'
          ? reasonText(reasonCode)
          : reasonText(title ?? (status === 'DISABLED' ? 'DISABLED' : reasonCode));
    await notifyTemplate(tx, updated, notice, detail, String(at.getTime()));
  }
};

const qualityUpdate = async (
  tx: TemplateContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
  at: Date,
): Promise<void> => {
  const v = parse('message_template_quality_update', value);
  const t = await findTemplate(tx, channel, v.message_template_id);
  if (!t || (t.quality && at.getTime() < t.quality.at.getTime())) return;
  const score = v.new_quality_score.toUpperCase();
  const quality: TemplateQuality = (TEMPLATE_QUALITY as readonly string[]).includes(score)
    ? (score as TemplateQuality)
    : 'UNKNOWN';
  if (t.quality?.score === quality) return;
  const updated = await WhatsAppTemplateModel.findOneAndUpdate(
    { _id: t._id },
    { $set: { quality: { score: quality, at } } },
    { returnDocument: 'after' },
  ).lean<WhatsAppTemplateDoc>();
  if (!updated) return;
  emitTemplateUpdated(updated);
  if (quality === 'RED') {
    await notifyTemplate(
      tx,
      updated,
      'template.quality_low',
      'customers reported low quality — WhatsApp may pause it',
      String(at.getTime()),
    );
  }
};

const categoryUpdate = async (
  tx: TemplateContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
  at: Date,
): Promise<void> => {
  const v = parse('template_category_update', value);
  const t = await findTemplate(tx, channel, v.message_template_id);
  if (!t || isStale(t, at)) return;
  const pending = asCategory(v.correct_category);
  if (pending && !v.previous_category) {
    // Meta warns 24 h before it recategorises: notify only
    const when = v.category_update_timestamp
      ? new Date(v.category_update_timestamp * 1000).toISOString().slice(0, 10)
      : 'soon';
    await notifyTemplate(
      tx,
      t,
      'template.category_changed',
      `WhatsApp will change the category to ${pending.toLowerCase()} (${when})`,
      `pending-${String(at.getTime())}`,
    );
    return;
  }
  const next = asCategory(v.new_category);
  if (!next || next === t.category) return;
  const updated = await WhatsAppTemplateModel.findOneAndUpdate(
    { _id: t._id },
    { $set: { category: next, previousCategory: t.category, lastEventAt: at } },
    { returnDocument: 'after' },
  ).lean<WhatsAppTemplateDoc>();
  if (!updated) return;
  emitTemplateUpdated(updated);
  await auditTemplate(updated, 'template.category_changed', SYSTEM_ACTOR, {
    from: t.category,
    to: next,
  });
  await notifyTemplate(
    tx,
    updated,
    'template.category_changed',
    `WhatsApp changed the category from ${t.category.toLowerCase()} to ${next.toLowerCase()}`,
    String(at.getTime()),
  );
};

/** Edited in WhatsApp Manager: the webhook carries texts only — a sync fetches the exact components. */
const componentsUpdate = async (
  tx: TemplateContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<void> => {
  const v = parse('message_template_components_update', value);
  const t = await findTemplate(tx, channel, v.message_template_id);
  if (t) await tx.jobs.enqueueSync(channel._id.toString(), 'webhook');
};

/** A customer stopped / resumed marketing messages in WhatsApp → the contact's flag. */
const userPreferences = async (
  _tx: TemplateContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
  at: Date,
): Promise<void> => {
  const v = parse('user_preferences', value);
  for (const pref of v.user_preferences) {
    if (pref.category !== 'marketing_messages') continue;
    const choice = pref.value.toLowerCase();
    if (choice !== 'stop' && choice !== 'resume') continue;
    const ts = Number(pref.timestamp);
    const eventAt = Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : at;
    for (const contact of await contactsForWaId(channel.accountId, pref.wa_id.replace(/\D/g, ''))) {
      await setMarketingPreference({
        accountId: channel.accountId,
        contactId: contact._id,
        stopped: choice === 'stop',
        source: 'user_preferences',
        at: eventAt,
      });
    }
  }
};

/** The template consumers the WhatsApp worker hands to its webhook handlers. */
export const createTemplateHooks = (tx: TemplateContext): TemplateHooks => {
  const run =
    (
      fn: (
        tx: TemplateContext,
        channel: WhatsAppChannelDoc,
        value: unknown,
        at: Date,
      ) => Promise<void>,
    ) =>
    async (channel: WhatsAppChannelDoc, value: unknown, at: Date) => {
      try {
        await fn(tx, channel, value, at);
      } catch (err) {
        if (err instanceof WebhookSchemaError) throw err;
        getLogger().warn(
          { channelId: channel._id.toString(), errName: (err as Error).name },
          'templates: webhook handling failed',
        );
        throw err;
      }
    };
  return {
    message_template_status_update: run(statusUpdate),
    message_template_quality_update: run(qualityUpdate),
    template_category_update: run(categoryUpdate),
    message_template_components_update: run(componentsUpdate),
    user_preferences: run(userPreferences),
  };
};
