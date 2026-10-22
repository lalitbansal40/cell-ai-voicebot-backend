import { Types } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';

import { nowOf, openSecret, type WhatsAppContext } from './context';

/**
 * Contract for later phases (§1q): webhook fields Phase 9 only stores (`deferred`)
 * are read by their consumers (Phase 10 messages / echoes / history, 11 templates,
 * 12 calls) through `listDeferred` and acknowledged with `markConsumed`.
 */
const consumers = new Set<string>();

/** A later phase declares that it consumes `field` (documentation + admin view). */
export const registerDeferredField = (field: string): void => {
  consumers.add(field);
};

export const deferredConsumers = (): string[] => [...consumers].sort();

export interface DeferredEvent {
  id: string;
  field: string;
  accountId: string | null;
  channelId: string | null;
  receivedAt: Date;
  /** The opened Meta change value (PII inside — never log it). */
  value: unknown;
}

export interface ListDeferredInput {
  field: string;
  channelId?: Types.ObjectId | string;
  limit?: number;
  /** Id of the last event of the previous page. */
  cursor?: string | null;
}

/** Oldest first; `nextCursor` while more remain. */
export const listDeferred = async (
  ctx: Pick<WhatsAppContext, 'key'>,
  input: ListDeferredInput,
): Promise<{ items: DeferredEvent[]; nextCursor: string | null }> => {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await MetaWebhookEventModel.find({
    field: input.field,
    status: 'deferred',
    ...(input.channelId ? { channelId: new Types.ObjectId(input.channelId) } : {}),
    ...(input.cursor ? { _id: { $gt: new Types.ObjectId(input.cursor) } } : {}),
  })
    .select('+payloadSealed')
    .sort({ _id: 1 })
    .limit(limit + 1)
    .lean<
      {
        _id: Types.ObjectId;
        field: string;
        accountId: Types.ObjectId | null;
        channelId: Types.ObjectId | null;
        receivedAt: Date;
        payloadSealed: string;
      }[]
    >();
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => ({
      id: r._id.toString(),
      field: r.field,
      accountId: r.accountId?.toString() ?? null,
      channelId: r.channelId?.toString() ?? null,
      receivedAt: r.receivedAt,
      value: JSON.parse(openSecret(ctx, r.payloadSealed)) as unknown,
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
};

/** Consumed events become `processed` and expire on the normal schedule. */
export const markConsumed = async (
  ctx: Pick<WhatsAppContext, 'now'>,
  eventIds: string[],
): Promise<number> => {
  if (!eventIds.length) return 0;
  const now = nowOf(ctx);
  const res = await MetaWebhookEventModel.updateMany(
    { _id: { $in: eventIds.map((id) => new Types.ObjectId(id)) }, status: 'deferred' },
    {
      $set: {
        status: 'processed',
        consumedAt: now,
        expiresAt: new Date(now.getTime() + WHATSAPP_LIMITS.webhookEventTtlDays * 86_400_000),
      },
    },
  );
  return res.modifiedCount;
};
