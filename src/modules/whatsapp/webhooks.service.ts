import { createHash } from 'node:crypto';

import { WHATSAPP_LIMITS } from '../../config/limits';
import {
  metaAppSecret,
  phoneNumberIdOf,
  safeEqualString,
  verifyWebhookSignature,
  WEBHOOK_OBJECT,
  webhookEnvelopeSchema,
  type WebhookEnvelope,
} from '../../core/meta';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import {
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
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
/** Call ids + kinds of a `calls` value (connect / terminate events, call statuses). */
export const callsOf = (value: unknown): { waCallId: string; kind: string }[] => {
  const v = value as {
    calls?: { id?: unknown; event?: unknown }[] | null;
    statuses?: { id?: unknown; status?: unknown; type?: unknown }[] | null;
  } | null;
  const out: { waCallId: string; kind: string }[] = [];
  for (const c of Array.isArray(v?.calls) ? v.calls : []) {
    if (typeof c.id === 'string' && typeof c.event === 'string') {
      out.push({ waCallId: c.id, kind: c.event });
    }
  }
  for (const st of Array.isArray(v?.statuses) ? v.statuses : []) {
    if (typeof st.id === 'string' && typeof st.status === 'string') {
      out.push({ waCallId: st.id, kind: st.status.toUpperCase() });
    }
  }
  return out;
};

/** Never blocks Meta's 200: a failed publish is logged with ids, the worker path still runs. */
const fastPath = (ctx: WhatsAppContext, eventId: string, value: unknown): void => {
  const send = ctx.callsFastPath;
  if (!send) return;
  for (const { waCallId, kind } of callsOf(value)) {
    void send({ eventId, waCallId, kind }).catch((err: unknown) => {
      getLogger().warn(
        { eventId, waCallId, kind, errName: (err as Error).name },
        'meta webhook: calls fast path failed',
      );
    });
  }
};

/** A JSON body that must be Meta's webhook envelope (Meta route and the Pinnacle relay). */
export const parseEnvelope = (rawBody: Buffer): WebhookEnvelope => {
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
  return parsed.data;
};

export const receiveWebhook = async (
  ctx: WhatsAppContext,
  jobs: WhatsAppJobs,
  rawBody: Buffer,
  signature: string | undefined,
): Promise<WebhookReceipt> => {
  if (!verifyWebhookSignature(rawBody, signature, metaAppSecret(ctx.env))) {
    getLogger().warn({ metric: 'meta_webhook_signature_invalid' }, 'meta webhook: bad signature');
    throw new AppError('META_SIGNATURE_INVALID');
  }
  return ingestEnvelope(ctx, jobs, parseEnvelope(rawBody), { source: 'meta' });
};

/**
 * Fake provider only (simulators, the fake's auto events): the fake Meta speaks for every
 * number, so each change goes in as its number would really arrive — a managed (Pinnacle)
 * number's through the relay path, the others as Meta's. With the real Meta this is
 * `receiveWebhook`.
 */
export const receiveSimulatedWebhook = async (
  ctx: WhatsAppContext,
  jobs: WhatsAppJobs,
  rawBody: Buffer,
  signature: string | undefined,
): Promise<WebhookReceipt> => {
  if (ctx.meta.provider !== 'fake') return receiveWebhook(ctx, jobs, rawBody, signature);
  if (!verifyWebhookSignature(rawBody, signature, metaAppSecret(ctx.env))) {
    getLogger().warn({ metric: 'meta_webhook_signature_invalid' }, 'meta webhook: bad signature');
    throw new AppError('META_SIGNATURE_INVALID');
  }
  const envelope = parseEnvelope(rawBody);
  const phoneIds = envelope.entry.flatMap((e) =>
    e.changes.map((c) => phoneNumberIdOf(c.value)).filter((id): id is string => !!id),
  );
  const managed = phoneIds.length
    ? await WhatsAppChannelModel.find({
        phoneNumberId: { $in: phoneIds },
        provider: 'pinnacle',
        status: { $in: WA_ACTIVE_STATUSES },
      })
        .select({ wabaId: 1, phoneNumberId: 1 })
        .lean<Pick<WhatsAppChannelDoc, '_id' | 'wabaId' | 'phoneNumberId'>[]>()
    : [];
  const total = { received: 0, duplicates: 0, ignored: false };
  const add = (r: WebhookReceipt) => {
    total.received += r.received;
    total.duplicates += r.duplicates;
    total.ignored = total.ignored || r.ignored;
  };
  for (const channel of managed) {
    add(await ingestEnvelope(ctx, jobs, envelope, { source: 'pinnacle', channel }));
  }
  add(await ingestEnvelope(ctx, jobs, envelope, { source: 'meta' }));
  return total;
};

/** Where an envelope came from — Meta directly, or Pinnacle's relay for one managed number. */
export type EnvelopeSource =
  | { source: 'meta' }
  | { source: 'pinnacle'; channel: Pick<WhatsAppChannelDoc, '_id' | 'wabaId' | 'phoneNumberId'> };

/**
 * Phone number ids of active managed (Pinnacle) numbers — one query per 30 s per process
 * (Meta sends thousands of status webhooks). A stale moment is harmless: the same event
 * from both paths has the same idempotency key and is stored once.
 */
const MANAGED_CACHE_MS = 30_000;
let managedCache: { at: number; ids: Set<string> } | null = null;
const managedNumbers = async (): Promise<Set<string>> => {
  const now = Date.now();
  if (managedCache && now - managedCache.at < MANAGED_CACHE_MS) return managedCache.ids;
  const rows = await WhatsAppChannelModel.find({
    provider: 'pinnacle',
    status: { $in: WA_ACTIVE_STATUSES },
    phoneNumberId: { $type: 'string' },
  })
    .select({ phoneNumberId: 1 })
    .lean<{ phoneNumberId: string }[]>();
  managedCache = { at: now, ids: new Set(rows.map((r) => r.phoneNumberId)) };
  return managedCache.ids;
};

/** Forget the managed numbers cache (a number was added / disconnected here; tests). */
export const resetManagedNumbersCache = (): void => {
  managedCache = null;
};

/**
 * PN (D10): which changes of the envelope belong to this source. The Pinnacle relay may only
 * carry its own number's events; Meta's own deliveries for a managed number are dropped
 * (the relay brings them — one handler run per event).
 */
const changesFor = async (envelope: WebhookEnvelope, from: EnvelopeSource) => {
  const all = envelope.entry.flatMap((entry) =>
    entry.changes.map((change) => ({
      entry,
      change,
      phoneNumberId: phoneNumberIdOf(change.value),
    })),
  );
  if (from.source === 'pinnacle') {
    const { channel } = from;
    const kept = all.filter(({ entry, phoneNumberId }) =>
      phoneNumberId ? phoneNumberId === channel.phoneNumberId : entry.id === channel.wabaId,
    );
    if (kept.length < all.length) {
      getLogger().warn(
        {
          metric: 'pinnacle_webhook_foreign_number',
          dropped: all.length - kept.length,
          channelId: channel._id.toString(),
        },
        'pinnacle webhook: changes for another number dropped',
      );
    }
    return kept;
  }
  if (!all.some((c) => c.phoneNumberId)) return all;
  const skip = await managedNumbers();
  if (!skip.size) return all;
  const kept = all.filter((c) => !c.phoneNumberId || !skip.has(c.phoneNumberId));
  if (kept.length === all.length) return all;
  getLogger().info(
    { metric: 'meta_webhook_foreign_provider', dropped: all.length - kept.length },
    'meta webhook: managed numbers come through the partner relay',
  );
  return kept;
};

/** Stores each change once (idempotency key), queues it, and hands `calls` to the fast path. */
export const ingestEnvelope = async (
  ctx: WhatsAppContext,
  jobs: WhatsAppJobs,
  envelope: WebhookEnvelope,
  from: EnvelopeSource,
): Promise<WebhookReceipt> => {
  const log = getLogger();
  const label = from.source === 'meta' ? 'meta webhook' : 'pinnacle webhook';
  if (envelope.object !== WEBHOOK_OBJECT) {
    log.info(
      { metric: 'meta_webhook', source: from.source, received: 0, duplicates: 0, ignored: 1 },
      `${label}: other object`,
    );
    return { received: 0, duplicates: 0, ignored: true };
  }
  const now = nowOf(ctx);
  const expiresAt = new Date(now.getTime() + WHATSAPP_LIMITS.webhookEventTtlDays * 86_400_000);
  let received = 0;
  let duplicates = 0;
  let changes: Awaited<ReturnType<typeof changesFor>>;
  try {
    changes = await changesFor(envelope, from);
  } catch (err) {
    log.error({ err, metric: 'meta_webhook_unavailable' }, `${label}: routing check failed`);
    throw unavailable(err);
  }
  try {
    for (const { entry, change, phoneNumberId } of changes) {
      const key = eventKey(envelope.object, entry.id, change.field, change.value, entry.time);
      const res = await MetaWebhookEventModel.updateOne(
        { key },
        {
          $setOnInsert: {
            key,
            object: envelope.object,
            field: change.field,
            wabaId: entry.id,
            phoneNumberId,
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
            source: from.source,
          },
        },
        { upsert: true },
      );
      if (res.upsertedId) {
        received += 1;
        await jobs.enqueueEvent(res.upsertedId.toString());
        if (change.field === 'calls') fastPath(ctx, res.upsertedId.toString(), change.value);
        continue;
      }
      duplicates += 1;
      const existing = await MetaWebhookEventModel.findOne({ key })
        .select({ status: 1 })
        .lean<{ _id: { toString(): string }; status: string }>();
      // stored before but never queued (Redis was down) → queue it now (same job id)
      if (existing?.status === 'received') await jobs.enqueueEvent(existing._id.toString());
    }
  } catch (err) {
    log.error({ err, metric: 'meta_webhook_unavailable' }, `${label}: store / queue failed`);
    throw unavailable(err);
  }
  log.info(
    { metric: 'meta_webhook', source: from.source, received, duplicates, ignored: 0 },
    `${label}: stored`,
  );
  return { received, duplicates, ignored: false };
};
