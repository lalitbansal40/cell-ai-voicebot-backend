import type { ClientSession } from 'mongoose';
import { Types } from 'mongoose';

import { WebhookDeliveryModel } from '../../db/models/webhook-delivery.model';
import { WebhookEndpointModel } from '../../db/models/webhook-endpoint.model';
import { WebhookEventModel } from '../../db/models/webhook-event.model';
import { ulid } from '../../shared/ids/ulid';
import { getLogger } from '../../shared/logger';

import { getWebhookJobs } from './jobs';

/** The v1 event catalogue (PHASE_15_PLAN §1c). Names are a stable contract. */
export const WEBHOOK_EVENT_TYPES = [
  'call.started',
  'call.completed',
  'call.insights.ready',
  'campaign.completed',
  'whatsapp.message.received',
  'whatsapp.message.status',
  'whatsapp.call.started',
  'whatsapp.call.ended',
  'whatsapp.call.missed',
  'contact.opted_out',
  'contact.opted_in',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_API_VERSION = '2026-10';

/**
 * Fields only sent to endpoints with `includePersonalData` (phone, name, summary,
 * message text) — removed from `data` for every other endpoint.
 */
export const PERSONAL_FIELDS = ['phone', 'name', 'summary', 'text'] as const;

/** `data` without the personal fields (one level deep: `contact.phone` too). */
export const withoutPersonalData = (data: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if ((PERSONAL_FIELDS as readonly string[]).includes(k)) continue;
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
        ? withoutPersonalData(v as Record<string, unknown>)
        : v;
  }
  return out;
};

export const newEventId = (now = Date.now()): string => `evt_${ulid(now)}`;

/** Endpoints of the account that take this event type. */
const matchingEndpoints = (accountId: Types.ObjectId, type: string) =>
  WebhookEndpointModel.find({ accountId, active: true, events: { $in: [type, '*'] } })
    .select({ _id: 1 })
    .lean();

/** One delivery row + one job per endpoint (separate jobs: a slow receiver never delays another). */
export const fanOut = async (eventId: string, accountId: Types.ObjectId, type: string) => {
  const endpoints = await matchingEndpoints(accountId, type);
  let queued = 0;
  for (const e of endpoints) {
    try {
      const delivery = await WebhookDeliveryModel.create({
        accountId,
        endpointId: e._id,
        eventId,
        type,
        test: false,
        status: 'pending',
        nextAttemptAt: new Date(),
      });
      await getWebhookJobs().enqueueDelivery(delivery._id.toString(), 1, 0);
      queued += 1;
    } catch (err) {
      // the unique { endpointId, eventId } index: this event was already fanned out
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return queued;
};

/**
 * The one way to publish an account event to webhooks (ADR 0046): writes the outbox
 * row (inside the caller's transaction when `session` is given — fanned out only once
 * that session ended and the row is really there), then a delivery per matching
 * endpoint. Never throws into the caller; logs counts only.
 */
export const emitAccountEvent = async (
  accountId: Types.ObjectId | string,
  type: WebhookEventType,
  data: Record<string, unknown>,
  {
    session,
    at = new Date(),
    key,
  }: {
    session?: ClientSession;
    at?: Date;
    /** De-duplication key: a second event with the same key is dropped (retries, redeliveries). */
    key?: string;
  } = {},
): Promise<string | null> => {
  const account = typeof accountId === 'string' ? new Types.ObjectId(accountId) : accountId;
  const id = newEventId(at.getTime());
  try {
    try {
      await WebhookEventModel.create(
        [{ _id: id, accountId: account, type, data, key: key ?? null, createdAt: at }],
        { ...(session ? { session } : {}) },
      );
    } catch (err) {
      // the same real change was already published (a retry, a redelivery)
      if ((err as { code?: number }).code === 11000 && key) return null;
      throw err;
    }
    const run = async () => {
      if (session && !(await WebhookEventModel.exists({ _id: id }))) return; // rolled back
      const queued = await fanOut(id, account, type);
      if (queued) getLogger().debug({ type, queued }, 'webhooks: event queued');
    };
    if (session) {
      session.once('ended', () => {
        run().catch((err: unknown) => getLogger().error({ err, type }, 'webhooks: fan-out failed'));
      });
    } else await run();
    return id;
  } catch (err) {
    getLogger().error({ err, type }, 'webhooks: event not recorded');
    return null;
  }
};
