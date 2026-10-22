import { INBOX_LIMITS } from '../../config/limits';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import { listDeferred, markConsumed, registerDeferredField } from '../whatsapp/deferred-events';
import { WebhookSchemaError } from '../whatsapp/webhook-handlers';

import type { InboxContext } from './context';
import { createInboxHooks } from './hooks';

/** Webhook fields the inbox consumes (Phase 9 stored them as `deferred`). */
export const INBOX_FIELDS = [
  'messages',
  'smb_message_echoes',
  'smb_app_state_sync',
  'history',
] as const;
for (const field of INBOX_FIELDS) registerDeferredField(field);

const cursorKey = (field: string) => `inbox-backfill-cursor-${field}`;

/** Are there deferred inbox events (stored before Phase 10, or while the worker had no inbox)? */
export const hasDeferredInboxEvents = async (): Promise<boolean> =>
  Boolean(
    await MetaWebhookEventModel.exists({ field: { $in: [...INBOX_FIELDS] }, status: 'deferred' }),
  );

export interface BackfillResult {
  processed: number;
  queued: number;
  skipped: number;
  failed: number;
}

/**
 * `inbox.backfill` job: every deferred inbox event, oldest first, in pages of 200,
 * through the same consumers as live webhooks (idempotent by wamid), then consumed.
 * History events are handed to their import job. Events of numbers no longer
 * connected stay deferred (they expire). Resumable: a cursor per field in Redis.
 */
export const runInboxBackfill = async (ix: InboxContext): Promise<BackfillResult> => {
  const hooks = createInboxHooks(ix);
  const result: BackfillResult = { processed: 0, queued: 0, skipped: 0, failed: 0 };
  const channels = new Map<string, WhatsAppChannelDoc | null>();
  const channelOf = async (id: string | null) => {
    if (!id) return null;
    if (!channels.has(id)) {
      channels.set(
        id,
        await WhatsAppChannelModel.findOne({
          _id: id,
          status: { $in: WA_ACTIVE_STATUSES },
        }).lean<WhatsAppChannelDoc>(),
      );
    }
    return channels.get(id) ?? null;
  };
  for (const field of INBOX_FIELDS) {
    let cursor = await ix.wa.redis.get(cursorKey(field));
    for (;;) {
      const page = await listDeferred(ix.wa, {
        field,
        limit: INBOX_LIMITS.backfillBatchSize,
        cursor,
      });
      for (const event of page.items) {
        const channel = await channelOf(event.channelId);
        if (!channel) {
          result.skipped += 1;
          continue;
        }
        try {
          if (field === 'history') {
            await hooks.history(channel, event.id);
            result.queued += 1;
            continue;
          }
          if (field === 'messages') await hooks.messages(channel, event.value);
          else if (field === 'smb_message_echoes') await hooks.echoes(channel, event.value);
          else await hooks.stateSync(channel, event.value);
          await markConsumed(ix.wa, [event.id]);
          result.processed += 1;
        } catch (err) {
          if (!(err instanceof WebhookSchemaError)) throw err;
          // a payload that never parses: mark it failed (no retry loop)
          await MetaWebhookEventModel.updateOne(
            { _id: event.id },
            { $set: { status: 'failed', error: err.message } },
          );
          result.failed += 1;
        }
      }
      const last = page.items.at(-1)?.id;
      if (last) {
        cursor = last;
        await ix.wa.redis.set(cursorKey(field), last, 'EX', 7 * 86_400);
      }
      if (!page.nextCursor) break;
    }
    await ix.wa.redis.del(cursorKey(field));
  }
  getLogger().info({ ...result }, 'inbox: backfill done');
  return result;
};
