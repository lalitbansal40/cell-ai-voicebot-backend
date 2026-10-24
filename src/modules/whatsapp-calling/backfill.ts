import { WHATSAPP_LIMITS } from '../../config/limits';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import { nowOf, type WhatsAppContext } from '../whatsapp/context';

/** `error` text of `calls` events stored before Phase 12 (never replayed). */
export const IGNORED_STALE = 'ignored_stale';

export const hasDeferredCallEvents = async (): Promise<boolean> =>
  (await MetaWebhookEventModel.exists({ field: 'calls', status: 'deferred' })) !== null;

/**
 * `whatsapp.calls_backfill_ignore` (worker start, once): `calls` events Phase 9 stored
 * as deferred belong to calls that ended long ago — they are marked `ignored`
 * (`error: ignored_stale`) and expire on the normal schedule. Replaying them would
 * ring or charge for calls that no longer exist.
 */
export const ignoreStaleCallEvents = async (ctx: Pick<WhatsAppContext, 'now'>): Promise<number> => {
  const now = nowOf(ctx);
  const res = await MetaWebhookEventModel.updateMany(
    { field: 'calls', status: 'deferred' },
    {
      $set: {
        status: 'ignored',
        error: IGNORED_STALE,
        consumedAt: now,
        expiresAt: new Date(now.getTime() + WHATSAPP_LIMITS.webhookEventTtlDays * 86_400_000),
      },
    },
  );
  return res.modifiedCount;
};
