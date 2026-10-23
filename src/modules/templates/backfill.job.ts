import { TEMPLATE_LIMITS } from '../../config/limits';
import type { TemplateWebhookField } from '../../core/meta';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import { listDeferred, markConsumed, registerDeferredField } from '../whatsapp/deferred-events';
import { WebhookSchemaError } from '../whatsapp/webhook-handlers';

import type { TemplateContext } from './context';
import { createTemplateHooks } from './webhooks';

/** Webhook fields the templates module consumes (Phase 9 stored them as `deferred`). */
export const TEMPLATE_FIELDS = [
  'message_template_status_update',
  'message_template_quality_update',
  'template_category_update',
  'message_template_components_update',
  'user_preferences',
] as const satisfies readonly TemplateWebhookField[];
for (const field of TEMPLATE_FIELDS) registerDeferredField(field);

const CURSOR_KEY = 'templates-backfill-cursor';

export const hasDeferredTemplateEvents = async (): Promise<boolean> =>
  Boolean(
    await MetaWebhookEventModel.exists({
      field: { $in: [...TEMPLATE_FIELDS] },
      status: 'deferred',
    }),
  );

export interface TemplateBackfillResult {
  processed: number;
  skipped: number;
  failed: number;
}

/**
 * `templates.backfill` job: every deferred template / preference event, all fields
 * together in arrival order (a status after an older category change), through the
 * live handlers, then consumed. Events of numbers no longer connected stay deferred
 * (they expire). Resumable: one cursor in Redis.
 */
export const runTemplatesBackfill = async (
  tx: TemplateContext,
): Promise<TemplateBackfillResult> => {
  const hooks = createTemplateHooks(tx);
  const result: TemplateBackfillResult = { processed: 0, skipped: 0, failed: 0 };
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
  let cursor = await tx.wa.redis.get(CURSOR_KEY);
  for (;;) {
    const page = await listDeferred(tx.wa, {
      field: TEMPLATE_FIELDS,
      limit: TEMPLATE_LIMITS.syncPageSize,
      cursor,
    });
    for (const event of page.items) {
      const channel = await channelOf(event.channelId);
      if (!channel) {
        result.skipped += 1;
        continue;
      }
      try {
        await hooks[event.field as TemplateWebhookField](channel, event.value, event.receivedAt);
        await markConsumed(tx.wa, [event.id]);
        result.processed += 1;
      } catch (err) {
        if (!(err instanceof WebhookSchemaError)) throw err;
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
      await tx.wa.redis.set(CURSOR_KEY, last, 'EX', 7 * 86_400);
    }
    if (!page.nextCursor) break;
  }
  await tx.wa.redis.del(CURSOR_KEY);
  getLogger().info({ ...result }, 'templates: backfill done');
  return result;
};
