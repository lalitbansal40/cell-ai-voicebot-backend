import type { Types } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
import type { WebhookField } from '../../core/meta';
import {
  MetaWebhookEventModel,
  type MetaEventStatus,
} from '../../db/models/meta-webhook-event.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';

import { nowOf } from './context';
import {
  LONG_LIVED_FIELDS,
  openPayload,
  WEBHOOK_HANDLERS,
  WebhookSchemaError,
  type HandlerContext,
} from './webhook-handlers';

interface StoredEvent {
  _id: Types.ObjectId;
  field: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  payloadSealed: string;
  status: MetaEventStatus;
  attempts: number;
  receivedAt: Date;
}

const DAY = 86_400_000;

/** Channels an event belongs to: by phone number id, else every active channel of the WABA. */
export const routeEvent = async (event: Pick<StoredEvent, 'phoneNumberId' | 'wabaId'>) => {
  if (event.phoneNumberId) {
    return WhatsAppChannelModel.find({
      phoneNumberId: event.phoneNumberId,
      status: { $in: WA_ACTIVE_STATUSES },
    }).lean<WhatsAppChannelDoc[]>();
  }
  if (!event.wabaId) return [];
  return WhatsAppChannelModel.find({
    wabaId: event.wabaId,
    status: { $in: WA_ACTIVE_STATUSES },
  }).lean<WhatsAppChannelDoc[]>();
};

/** At most one `webhook.lastEventAt` write per channel per `lastEventThrottleMs`. */
const touch = async (channel: WhatsAppChannelDoc, field: string, now: Date) => {
  const last = channel.webhook.lastEventAt?.getTime() ?? 0;
  if (now.getTime() - last < WHATSAPP_LIMITS.lastEventThrottleMs) return;
  await WhatsAppChannelModel.updateOne(
    { _id: channel._id },
    { $set: { 'webhook.lastEventAt': now, 'webhook.lastField': field } },
  );
};

export interface ProcessOptions {
  /** This is the job's last attempt: an error marks the event `failed`. */
  finalAttempt: boolean;
}

/**
 * Worker side of the pipeline: open the sealed payload, route, run the field's
 * handler for every routed channel, store the outcome. Already finished events are
 * skipped (redelivered jobs). Schema mismatches fail at once; other errors are
 * rethrown for BullMQ's retries and mark the event `failed` on the last attempt.
 */
export const processWebhookEvent = async (
  h: HandlerContext,
  eventId: string,
  options: ProcessOptions,
): Promise<MetaEventStatus | null> => {
  const event = await MetaWebhookEventModel.findById(eventId)
    .select('+payloadSealed')
    .lean<StoredEvent>();
  if (!event || event.status !== 'received') return event?.status ?? null;
  const now = nowOf(h.ctx);
  const finish = (status: MetaEventStatus, extra: Record<string, unknown> = {}) =>
    MetaWebhookEventModel.updateOne(
      { _id: event._id },
      { $set: { status, processedAt: now, error: null, ...extra }, $inc: { attempts: 1 } },
    ).then(() => status);
  try {
    const channels = await routeEvent(event);
    const first = channels[0];
    if (!first) return await finish('ignored');
    const value = openPayload(h.ctx, event.payloadSealed);
    const handler = WEBHOOK_HANDLERS[event.field as WebhookField];
    let status: MetaEventStatus = 'deferred';
    for (const channel of channels) {
      await touch(channel, event.field, now);
      if (handler)
        status = await handler(h, channel, value, { eventId, receivedAt: event.receivedAt });
    }
    const keepDays =
      status === 'deferred'
        ? LONG_LIVED_FIELDS.has(event.field) || !handler
          ? WHATSAPP_LIMITS.deferredEventTtlDays
          : WHATSAPP_LIMITS.webhookEventTtlDays
        : WHATSAPP_LIMITS.webhookEventTtlDays;
    return await finish(status, {
      accountId: first.accountId,
      channelId: first._id,
      expiresAt: new Date(event.receivedAt.getTime() + keepDays * DAY),
    });
  } catch (err) {
    const schema = err instanceof WebhookSchemaError;
    const message = schema ? err.message : `processing failed (${(err as Error).name})`;
    getLogger().warn(
      { eventId, field: event.field, attempt: event.attempts + 1, schema },
      'meta webhook: event failed',
    );
    if (schema || options.finalAttempt) {
      await MetaWebhookEventModel.updateOne(
        { _id: event._id },
        { $set: { status: 'failed', error: message, processedAt: now }, $inc: { attempts: 1 } },
      );
      return 'failed';
    }
    await MetaWebhookEventModel.updateOne(
      { _id: event._id },
      { $set: { error: message }, $inc: { attempts: 1 } },
    );
    throw err;
  }
};

/** Maintenance backup of the TTL index (`whatsapp-events-purge`). */
export const purgeWebhookEvents = async (now = new Date()): Promise<{ deleted: number }> => {
  const res = await MetaWebhookEventModel.deleteMany({ expiresAt: { $lt: now } });
  return { deleted: res.deletedCount };
};
