import { createHash } from 'node:crypto';

import { WHATSAPP_LIMITS } from '../../config/limits';
import {
  metaAppSecret,
  phoneNumberIdOf,
  safeEqualString,
  verifyWebhookSignature,
  WEBHOOK_OBJECT,
  webhookEnvelopeSchema,
} from '../../core/meta';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import { nowOf, sealSecret, type WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';

/** JSON with sorted keys (the same change value always gives the same key). */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
};

/** Idempotency key of one `entry × change` (Meta redelivers the same payload). */
/**
 * Fields whose value carries no time of its own: the same event can legitimately come
 * again later (an edited template approved again), so the entry time is part of the key.
 */
const TIMELESS_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'template_category_update',
  'message_template_components_update',
]);

export const eventKey = (
  object: string,
  entryId: string,
  field: string,
  value: unknown,
  entryTime?: number | null,
): string =>
  createHash('sha256')
    .update(
      `${object}|${entryId}|${field}|${stableStringify(value)}${
        TIMELESS_FIELDS.has(field) && entryTime ? `|${String(entryTime)}` : ''
      }`,
    )
    .digest('hex');

/** `GET /webhooks/meta` — the challenge to echo, or `null` (→ 403). Constant-time token compare. */
export const verifyChallenge = (
  ctx: Pick<WhatsAppContext, 'env'>,
  query: Record<string, unknown>,
): string | null => {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const expected = ctx.env.META_WEBHOOK_VERIFY_TOKEN;
  if (mode !== 'subscribe' || typeof token !== 'string' || typeof challenge !== 'string')
    return null;
  if (!expected || !safeEqualString(token, expected)) return null;
  return challenge.slice(0, 200);
};

export interface WebhookReceipt {
  received: number;
  duplicates: number;
  ignored: boolean;
}

const unavailable = (err: unknown) =>
  new AppError(
    'PROVIDER_UNAVAILABLE',
    'Webhook storage is unavailable — Meta will retry.',
    undefined,
    {
      cause: err,
    },
  );

/**
 * `POST /webhooks/meta` (§1f): signature over the raw bytes, then every
 * `entry[].changes[]` is stored once (sealed payload, idempotency key) and queued.
 * Events stored earlier but not processed yet are queued again (Redis was down) —
 * the job id keeps that to one job. Mongo / Redis failure → 503 (Meta retries).
 */
export const receiveWebhook = async (
  ctx: WhatsAppContext,
  jobs: WhatsAppJobs,
  rawBody: Buffer,
  signature: string | undefined,
): Promise<WebhookReceipt> => {
  const log = getLogger();
  if (!verifyWebhookSignature(rawBody, signature, metaAppSecret(ctx.env))) {
    log.warn({ metric: 'meta_webhook_signature_invalid' }, 'meta webhook: bad signature');
    throw new AppError('META_SIGNATURE_INVALID');
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new ValidationError([{ path: 'body', message: 'Expected a JSON body' }]);
  }
  const parsed = webhookEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError([{ path: 'body', message: 'Not a Meta webhook payload' }]);
  }
  const envelope = parsed.data;
  if (envelope.object !== WEBHOOK_OBJECT) {
    log.info(
      { metric: 'meta_webhook', received: 0, duplicates: 0, ignored: 1 },
      'meta webhook: other object',
    );
    return { received: 0, duplicates: 0, ignored: true };
  }
  const now = nowOf(ctx);
  const expiresAt = new Date(now.getTime() + WHATSAPP_LIMITS.webhookEventTtlDays * 86_400_000);
  let received = 0;
  let duplicates = 0;
  try {
    for (const entry of envelope.entry) {
      for (const change of entry.changes) {
        const key = eventKey(envelope.object, entry.id, change.field, change.value, entry.time);
        const res = await MetaWebhookEventModel.updateOne(
          { key },
          {
            $setOnInsert: {
              key,
              object: envelope.object,
              field: change.field,
              wabaId: entry.id,
              phoneNumberId: phoneNumberIdOf(change.value),
              accountId: null,
              channelId: null,
              payloadSealed: sealSecret(ctx, JSON.stringify(change.value ?? null)),
              status: 'received',
              attempts: 0,
              error: null,
              receivedAt: now,
              processedAt: null,
              consumedAt: null,
              expiresAt,
            },
          },
          { upsert: true },
        );
        if (res.upsertedId) {
          received += 1;
          await jobs.enqueueEvent(res.upsertedId.toString());
          continue;
        }
        duplicates += 1;
        const existing = await MetaWebhookEventModel.findOne({ key })
          .select({ status: 1 })
          .lean<{ _id: { toString(): string }; status: string }>();
        // stored before but never queued (Redis was down) → queue it now (same job id)
        if (existing?.status === 'received') await jobs.enqueueEvent(existing._id.toString());
      }
    }
  } catch (err) {
    log.error({ err, metric: 'meta_webhook_unavailable' }, 'meta webhook: store / queue failed');
    throw unavailable(err);
  }
  log.info({ metric: 'meta_webhook', received, duplicates, ignored: 0 }, 'meta webhook: stored');
  return { received, duplicates, ignored: false };
};
