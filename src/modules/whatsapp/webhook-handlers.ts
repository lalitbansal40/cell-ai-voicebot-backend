import type { z } from 'zod';

import {
  isMetaApiError,
  normalizeTier,
  TEMPLATE_WEBHOOK_VALUE_SCHEMAS,
  VOLUME_TIER_EVENT,
  WEBHOOK_VALUE_SCHEMAS,
  type TemplateWebhookField,
  type WebhookField,
} from '../../core/meta';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';

import {
  emitChannelUpdated,
  markNeedsReconnect,
  notifyChannel,
  numberName,
  SYSTEM_ACTOR,
  transition,
} from './channel-status';
import { nowOf, openSecret, type WhatsAppContext } from './context';
import type { WhatsAppService } from './whatsapp.service';

export type HandlerResult = 'processed' | 'deferred';

/**
 * Phase 10 consumers of the fields Phase 9 only stored. Injected by the worker (the
 * inbox module builds them) so this module never imports the inbox. Without them
 * (scripts, Phase 9 tests) those events stay `deferred` for the backfill.
 */
export interface InboxHooks {
  messages(channel: WhatsAppChannelDoc, value: unknown): Promise<unknown>;
  echoes(channel: WhatsAppChannelDoc, value: unknown): Promise<unknown>;
  stateSync(channel: WhatsAppChannelDoc, value: unknown): Promise<unknown>;
  /** History chunks are imported by their own job (large); the event stays deferred until then. */
  history(channel: WhatsAppChannelDoc, eventId: string): Promise<unknown>;
}

/**
 * Phase 11 consumers (template webhooks, marketing preferences), injected the same way;
 * `at` = when we received the event (orders webhooks against syncs).
 */
export type TemplateHooks = Record<
  TemplateWebhookField,
  (channel: WhatsAppChannelDoc, value: unknown, at: Date) => Promise<unknown>
>;

export interface HandlerContext {
  ctx: WhatsAppContext;
  service: Pick<WhatsAppService, 'syncChannel'>;
  inbox?: InboxHooks;
  templates?: TemplateHooks;
}

/** The stored event being handled. */
export interface HandlerEvent {
  eventId: string;
  receivedAt?: Date;
}

/** A change value didn't match Meta's documented shape (event → `failed`, no retry). */
export class WebhookSchemaError extends Error {
  constructor(field: string) {
    super(`schema: unexpected ${field} payload`);
    this.name = 'WebhookSchemaError';
  }
}

const parse = <F extends keyof typeof WEBHOOK_VALUE_SCHEMAS>(
  field: F,
  value: unknown,
): z.infer<(typeof WEBHOOK_VALUE_SCHEMAS)[F]> => {
  const parsed = WEBHOOK_VALUE_SCHEMAS[field].safeParse(value);
  if (!parsed.success) throw new WebhookSchemaError(field);
  return parsed.data as z.infer<(typeof WEBHOOK_VALUE_SCHEMAS)[F]>;
};

const digits = (v: string | null | undefined) => v?.replace(/\D/g, '') ?? '';

/** WABA-level events name the number by its display number → only that channel. */
const isNumber = (channel: WhatsAppChannelDoc, display: string | null | undefined): boolean =>
  !display || digits(channel.displayPhoneNumber) === digits(display);

const update = async (
  channel: WhatsAppChannelDoc,
  set: Record<string, unknown>,
): Promise<WhatsAppChannelDoc> => {
  const updated = await WhatsAppChannelModel.findOneAndUpdate(
    { _id: channel._id },
    { $set: set },
    { returnDocument: 'after' },
  ).lean<WhatsAppChannelDoc>();
  if (!updated) return channel;
  emitChannelUpdated(updated);
  return updated;
};

/** A sync triggered by an event; token problems end in `needs_reconnect`, other errors are logged. */
const resync = async (h: HandlerContext, channel: WhatsAppChannelDoc) => {
  try {
    const full = await WhatsAppChannelModel.findById(channel._id)
      .select('+tokenSealed')
      .lean<WhatsAppChannelDoc>();
    if (full && full.status !== 'disconnected') await h.service.syncChannel(full, SYSTEM_ACTOR);
  } catch (err) {
    getLogger().warn(
      { channelId: channel._id.toString(), code: isMetaApiError(err) ? err.code : null },
      'whatsapp: event sync failed',
    );
  }
};

const RESTRICTING = new Set([
  'ACCOUNT_RESTRICTION',
  'DISABLED_UPDATE',
  'ACCOUNT_VIOLATION',
  'BANNED',
]);
const LIFTING_BAN_STATES = new Set(['REINSTATE', 'DISABLE_REVERSED']);
const REMOVED = new Set(['PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED', 'APP_UNSUBSCRIBED']);

const restrictionText = (event: string, type: string) =>
  event === 'ACCOUNT_VIOLATION'
    ? `Meta reported a policy violation (${type}).`
    : event === 'DISABLED_UPDATE'
      ? 'Meta scheduled this WhatsApp account to be disabled.'
      : `Meta restricted this WhatsApp account (${type}).`;

const accountUpdate = async (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<HandlerResult> => {
  const v = parse('account_update', value);
  if (v.event === VOLUME_TIER_EVENT) {
    // Phase 11: Meta's volume pricing tier (margin report info), last 10 kept
    if (v.volume_tier_info) {
      const info = v.volume_tier_info;
      await WhatsAppChannelModel.updateOne(
        { _id: channel._id },
        {
          $push: {
            pricingTier: {
              $each: [
                {
                  category: info.pricing_category.toLowerCase(),
                  market: info.region ?? null,
                  tier: info.tier,
                  at: info.tier_update_time ? new Date(info.tier_update_time * 1000) : nowOf(h.ctx),
                },
              ],
              $slice: -10,
            },
          },
        },
      );
    }
    return 'processed';
  }
  if (!isNumber(channel, v.phone_number)) return 'processed';
  if (REMOVED.has(v.event)) {
    await markNeedsReconnect(h.ctx, channel, {
      code: 'partner_removed',
      message: 'This app was removed from the WhatsApp account — reconnect the number.',
      step: null,
    });
    return 'processed';
  }
  const banStates = v.ban_info?.waba_ban_state ?? [];
  const lifted =
    banStates.some((s) => LIFTING_BAN_STATES.has(s)) ||
    (v.event === 'ACCOUNT_RESTRICTION' && !(v.restriction_info ?? []).length);
  if (RESTRICTING.has(v.event) && !lifted) {
    const first = v.restriction_info?.[0];
    const type =
      first?.restriction_type ?? v.violation_info?.violation_type ?? banStates[0] ?? v.event;
    const until = first?.expiration ? new Date(first.expiration * 1000) : null;
    await transition(
      h.ctx,
      channel,
      'restricted',
      { code: v.event.toLowerCase(), message: restrictionText(v.event, type), step: null },
      SYSTEM_ACTOR,
      { restriction: { type, until } },
    );
    return 'processed';
  }
  if (lifted && channel.status === 'restricted') {
    await update(channel, { restriction: null });
  }
  await resync(h, channel);
  return 'processed';
};

const qualityUpdate = async (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<HandlerResult> => {
  const v = parse('phone_number_quality_update', value);
  if (!isNumber(channel, v.display_phone_number)) return 'processed';
  const before = channel.qualityRating;
  let updated = await update(channel, {
    ...(normalizeTier(v.current_limit)
      ? { messagingLimitTier: normalizeTier(v.current_limit) }
      : {}),
  });
  await resync(h, updated);
  updated =
    (await WhatsAppChannelModel.findById(channel._id).lean<WhatsAppChannelDoc>()) ?? updated;
  // the re-check above already notified a turn to red; a flag on its own notifies here
  const becameRed = updated.qualityRating === 'RED' && before !== 'RED';
  if (v.event === 'FLAGGED' && !becameRed) {
    await notifyChannel(
      h.ctx,
      updated,
      'whatsapp.quality_low',
      'WhatsApp number quality is low',
      `${numberName(updated)}: Meta flagged the number — fewer messages may be delivered. Check recent messages for complaints.`,
    );
  }
  return 'processed';
};

const nameUpdate = async (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<HandlerResult> => {
  const v = parse('phone_number_name_update', value);
  if (!isNumber(channel, v.display_phone_number)) return 'processed';
  const decision = v.decision.toUpperCase();
  if (decision === 'APPROVED') {
    const updated = await update(channel, {
      nameStatus: 'APPROVED',
      newNameStatus: 'NONE',
      ...(v.requested_verified_name ? { verifiedName: v.requested_verified_name } : {}),
    });
    await notifyChannel(
      h.ctx,
      updated,
      'whatsapp.name_approved',
      'WhatsApp display name approved',
      `${numberName(updated)}: Meta approved the display name "${updated.verifiedName ?? ''}".`,
    );
  } else if (decision === 'REJECTED') {
    const updated = await update(channel, { newNameStatus: 'DECLINED' });
    await notifyChannel(
      h.ctx,
      updated,
      'whatsapp.name_rejected',
      'WhatsApp display name rejected',
      `${numberName(updated)}: Meta rejected the display name "${v.requested_verified_name ?? ''}"${v.rejection_reason && v.rejection_reason !== 'NONE' ? ` (${v.rejection_reason})` : ''}. Change it in WhatsApp Manager.`,
    );
  } else {
    await update(channel, { newNameStatus: decision });
  }
  return 'processed';
};

const capabilityUpdate = async (
  _h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<HandlerResult> => {
  const v = parse('business_capability_update', value);
  await update(channel, { capabilities: v });
  return 'processed';
};

const echoes = async (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<HandlerResult> => {
  parse('smb_message_echoes', value);
  await update(channel, { 'coexistence.echoesAt': nowOf(h.ctx) });
  if (!h.inbox) return 'deferred';
  await h.inbox.echoes(channel, value);
  return 'processed';
};

/** Phase 10: customer messages and statuses → the inbox. */
const messages = async (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<HandlerResult> => {
  if (!h.inbox) return 'deferred';
  await h.inbox.messages(channel, value);
  return 'processed';
};

const history = async (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
  event?: HandlerEvent,
): Promise<HandlerResult> => {
  const v = parse('history', value);
  if (v.history.some((c) => (c.errors ?? []).length)) {
    await update(channel, { 'coexistence.historySync': 'declined' });
    return 'deferred';
  }
  const progress = Math.max(
    channel.coexistence.historyProgress ?? 0,
    ...v.history.map((c) => c.metadata?.progress ?? 0),
  );
  await update(channel, {
    'coexistence.historyProgress': progress,
    'coexistence.historySync': progress >= 100 ? 'received' : 'requested',
  });
  if (h.inbox && event) await h.inbox.history(channel, event.eventId);
  return 'deferred';
};

const appStateSync = async (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
): Promise<HandlerResult> => {
  parse('smb_app_state_sync', value);
  await update(channel, { 'coexistence.contactsSync': 'received' });
  if (!h.inbox) return 'deferred';
  await h.inbox.stateSync(channel, value);
  return 'processed';
};

/** Phase 11: template / preference fields → the templates module (deferred without it). */
const templateField =
  (field: TemplateWebhookField): Handler =>
  async (h, channel, value, event) => {
    if (!TEMPLATE_WEBHOOK_VALUE_SCHEMAS[field].safeParse(value).success) {
      throw new WebhookSchemaError(field);
    }
    if (!h.templates) return 'deferred';
    await h.templates[field](channel, value, event?.receivedAt ?? nowOf(h.ctx));
    return 'processed';
  };

type Handler = (
  h: HandlerContext,
  channel: WhatsAppChannelDoc,
  value: unknown,
  event?: HandlerEvent,
) => Promise<HandlerResult>;

/** Phase 9 handlers + the Phase 10 inbox and Phase 11 template fields; others stay `deferred` (Phase 12). */
export const WEBHOOK_HANDLERS: Partial<Record<WebhookField, Handler>> = {
  messages,
  account_update: accountUpdate,
  phone_number_quality_update: qualityUpdate,
  phone_number_name_update: nameUpdate,
  business_capability_update: capabilityUpdate,
  smb_message_echoes: echoes,
  history,
  smb_app_state_sync: appStateSync,
  message_template_status_update: templateField('message_template_status_update'),
  message_template_quality_update: templateField('message_template_quality_update'),
  template_category_update: templateField('template_category_update'),
  message_template_components_update: templateField('message_template_components_update'),
  user_preferences: templateField('user_preferences'),
};

/** Fields kept 30 days instead of 7 while deferred (the inbox consumes them). */
export const LONG_LIVED_FIELDS = new Set([
  'messages',
  'smb_message_echoes',
  'history',
  'smb_app_state_sync',
  'message_template_status_update',
  'message_template_quality_update',
  'template_category_update',
  'message_template_components_update',
  'user_preferences',
]);

export const openPayload = (ctx: Pick<WhatsAppContext, 'key'>, sealed: string): unknown =>
  JSON.parse(openSecret(ctx, sealed)) as unknown;
