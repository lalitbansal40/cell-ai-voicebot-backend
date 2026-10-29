import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import type { Types } from 'mongoose';

import type { Env } from '../../config/env';
import { WEBHOOK_LIMITS } from '../../config/limits';
import { getEmail } from '../../core/email';
import { AccountModel } from '../../db/models/account.model';
import {
  WebhookDeliveryModel,
  type WebhookDeliveryDoc,
} from '../../db/models/webhook-delivery.model';
import {
  WebhookEndpointModel,
  type WebhookEndpointDoc,
} from '../../db/models/webhook-endpoint.model';
import { WebhookEventModel } from '../../db/models/webhook-event.model';
import { open, secretBoxKey } from '../../shared/crypto/secret-box';
import { getLogger } from '../../shared/logger';
import {
  outgoingPolicy,
  resolvePublicAddress,
  type GuardPolicy,
  type ResolveOptions,
} from '../../shared/net/url-guard';
import { recordAudit } from '../audit/audit.service';
import { notify, usersWithPermission } from '../notifications/notifications.service';

import { WEBHOOK_API_VERSION, withoutPersonalData } from './events';
import { getWebhookJobs, type WebhookDeliverJobData } from './jobs';
import { signatureHeader } from './signing';

export const USER_AGENT = 'NotifyNow-Webhooks/1.0';
const INTEGRATIONS_LINK = '/integrations/webhooks';

/** Where a webhook may be delivered + test hooks (fake resolver / dial to a local receiver). */
export interface WebhookRuntime extends ResolveOptions {
  /** Sealing key of the secrets (`secretBoxKey(env)`). */
  key: Buffer;
  policy: GuardPolicy;
  env: Pick<Env, 'FRONTEND_URL'>;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Webhook URL policy: the AI-function rules (https only + no private hosts in
 * production; private hosts only with the dev flag), every port allowed — receivers
 * pick their own (`extraPorts` is a function test hook only).
 */
export const webhookPolicy = (
  env: Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL'>,
): GuardPolicy => ({ ...outgoingPolicy(env), anyPort: true });

/** The production runtime (no test hooks). */
export type WebhookHooks = ResolveOptions & { timeoutMs?: number; now?: () => Date };

export const webhookRuntime = (
  env: Pick<
    Env,
    'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL' | 'FRONTEND_URL' | 'ENCRYPTION_KEY'
  >,
  hooks: WebhookHooks = {},
): WebhookRuntime => ({ key: secretBoxKey(env), policy: webhookPolicy(env), env, ...hooks });

const nowOf = (rt: WebhookRuntime) => rt.now?.() ?? new Date();

export interface PostResult {
  ok: boolean;
  responseStatus: number | null;
  responseMs: number;
  responseSnippet: string | null;
  /** `blocked`, `network`, `timeout`, `redirect`, `http_<status>`, `too_large`. */
  error: string | null;
}

const isText = (type: string) => !type || /(^text\/|json|xml|x-www-form-urlencoded)/i.test(type);

/** Reads at most the snippet size, then stops (never the whole body). */
const readSnippet = (res: IncomingMessage): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      const type = String(res.headers['content-type'] ?? '');
      resolve(
        isText(type)
          ? Buffer.concat(chunks).subarray(0, WEBHOOK_LIMITS.responseSnippetBytes).toString('utf8')
          : null,
      );
    };
    res.on('data', (chunk: Buffer) => {
      if (size < WEBHOOK_LIMITS.responseSnippetBytes) chunks.push(chunk);
      size += chunk.length;
      if (size >= WEBHOOK_LIMITS.responseSnippetBytes) {
        res.destroy();
        done();
      }
    });
    res.on('end', done);
    res.on('error', done);
    res.on('close', done);
  });

/**
 * POSTs one payload: the URL guard at connect time (DNS re-resolved, every address
 * checked, the pinned address dialed with the original host as SNI / Host), no
 * redirects followed, a hard timeout. Never throws.
 */
export const postWebhook = async (
  rt: WebhookRuntime,
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<PostResult> => {
  const started = Date.now();
  const fail = (error: string, responseStatus: number | null = null): PostResult => ({
    ok: false,
    responseStatus,
    responseMs: Date.now() - started,
    responseSnippet: null,
    error,
  });
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return fail('blocked');
  }
  const pinned = await resolvePublicAddress(target, rt.policy, rt);
  if (!pinned.ok) return fail(pinned.reason === 'network' ? 'network' : 'blocked');
  const https = target.protocol === 'https:';
  const timeoutMs = rt.timeoutMs ?? WEBHOOK_LIMITS.timeoutMs;
  return new Promise<PostResult>((resolve) => {
    const req = (https ? httpsRequest : httpRequest)({
      host: pinned.address,
      port: target.port || (https ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: { ...headers, host: target.host, 'content-length': Buffer.byteLength(body) },
      signal: AbortSignal.timeout(timeoutMs),
      ...(https ? { servername: target.hostname.replace(/^\[|\]$/g, '') } : {}),
    });
    req.on('response', (res) => {
      const status = res.statusCode ?? 0;
      void readSnippet(res).then((responseSnippet) => {
        const responseMs = Date.now() - started;
        if (status >= 200 && status < 300) {
          resolve({ ok: true, responseStatus: status, responseMs, responseSnippet, error: null });
        } else {
          resolve({
            ok: false,
            responseStatus: status,
            responseMs,
            responseSnippet,
            error: status >= 300 && status < 400 ? 'redirect' : `http_${String(status)}`,
          });
        }
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      resolve(
        fail(err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network'),
      );
    });
    req.end(body);
  });
};

/** The endpoint's secrets: current, plus the previous one while the rotation overlap lasts. */
export const signingSecrets = (rt: WebhookRuntime, endpoint: WebhookEndpointDoc): string[] => {
  const secrets = [open(rt.key, endpoint.secretSealed)];
  const overlapMs = WEBHOOK_LIMITS.secretRotationOverlapHours * 3_600_000;
  if (
    endpoint.secretPreviousSealed &&
    endpoint.rotatedAt &&
    nowOf(rt).getTime() - endpoint.rotatedAt.getTime() < overlapMs
  ) {
    secrets.push(open(rt.key, endpoint.secretPreviousSealed));
  }
  return secrets;
};

/** The exact JSON sent (`{ id, type, apiVersion, createdAt, accountId, data }`). */
export const payloadOf = (
  event: {
    id: string;
    type: string;
    createdAt: Date;
    accountId: string;
    data: Record<string, unknown>;
  },
  includePersonalData: boolean,
): string =>
  JSON.stringify({
    id: event.id,
    type: event.type,
    apiVersion: WEBHOOK_API_VERSION,
    createdAt: event.createdAt.toISOString(),
    accountId: event.accountId,
    data: includePersonalData ? event.data : withoutPersonalData(event.data),
  });

/** Signs and posts a payload to an endpoint (headers per PHASE_15_PROMPT §1). */
export const sendSigned = async (
  rt: WebhookRuntime,
  endpoint: WebhookEndpointDoc,
  eventId: string,
  raw: string,
): Promise<PostResult> => {
  if (Buffer.byteLength(raw) > WEBHOOK_LIMITS.maxPayloadBytes) {
    return {
      ok: false,
      responseStatus: null,
      responseMs: 0,
      responseSnippet: null,
      error: 'too_large',
    };
  }
  const timestamp = Math.floor(nowOf(rt).getTime() / 1000);
  return postWebhook(rt, endpoint.url, raw, {
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
    'x-webhook-id': eventId,
    'x-webhook-timestamp': String(timestamp),
    'x-webhook-signature': signatureHeader(signingSecrets(rt, endpoint), timestamp, raw),
  });
};

const loadEndpoint = (id: Types.ObjectId) =>
  WebhookEndpointModel.findById(id)
    .select('+secretSealed +secretPreviousSealed')
    .lean<WebhookEndpointDoc>();

/** URL host only (audit / e-mail — never the path or query). */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/**
 * Turns an endpoint off after repeated failures: notification + e-mail to owners /
 * admins (`integrations.manage`), audit `webhook_endpoint.disabled`. Only the first
 * caller of a transition does it.
 */
export const disableEndpoint = async (
  rt: WebhookRuntime,
  endpoint: Pick<WebhookEndpointDoc, '_id' | 'accountId' | 'url' | 'description'>,
  reason: 'failing',
  detail: { givenUp?: number; failingHours?: number },
): Promise<boolean> => {
  const at = nowOf(rt);
  const res = await WebhookEndpointModel.updateOne(
    { _id: endpoint._id, active: true },
    { $set: { active: false, disabledReason: reason, disabledAt: at } },
  );
  if (!res.modifiedCount) return false;
  const host = hostOf(endpoint.url);
  await recordAudit({
    accountId: endpoint.accountId,
    actor: { type: 'system' },
    action: 'webhook_endpoint.disabled',
    target: { type: 'webhook_endpoint', id: endpoint._id.toString() },
    meta: { host, reason, ...detail },
  });
  try {
    const recipients = await usersWithPermission(endpoint.accountId, 'integrations.manage');
    const title = 'A webhook was turned off';
    const body = `Deliveries to ${host} kept failing, so it was turned off. Fix the receiver and turn it on again.`;
    await notify({
      accountId: endpoint.accountId,
      userIds: recipients.map((r) => r.userId),
      type: 'webhook.endpoint_disabled',
      title,
      body,
      link: INTEGRATIONS_LINK,
    });
    const account = await AccountModel.findById(endpoint.accountId)
      .select({ name: 1 })
      .lean<{ name: string }>();
    for (const r of recipients) {
      await getEmail().enqueue(
        'webhooks.endpoint_disabled',
        r.email,
        {
          accountName: account?.name ?? 'Your account',
          host,
          description: endpoint.description,
          webhooksUrl: `${rt.env.FRONTEND_URL.replace(/\/+$/, '')}${INTEGRATIONS_LINK}`,
        },
        {
          dedupeKey: `wh-disabled-${endpoint._id.toString()}-${String(at.getTime())}-${r.userId.toString()}`,
        },
      );
    }
  } catch (err) {
    getLogger().error({ err }, 'webhooks: disable notice failed');
  }
  return true;
};

const MAX_ATTEMPT_ROWS = 10;

/**
 * `webhooks.deliver` (job id `wh-<deliveryId>-<attempt>`): one attempt. Success resets
 * the endpoint's failure streak; a failure schedules the next attempt (1 m, 5 m,
 * 30 m, 2 h, 12 h), the last one gives the event up — 5 given up in a row disable the
 * endpoint. Replays are one attempt. A job for an attempt already made is a no-op.
 */
export const deliverWebhook = async (
  rt: WebhookRuntime,
  data: WebhookDeliverJobData,
): Promise<{ status: string }> => {
  const delivery = await WebhookDeliveryModel.findById(data.deliveryId).lean<WebhookDeliveryDoc>();
  if (!delivery) return { status: 'missing' };
  if (delivery.attempt >= data.attempt) return { status: 'duplicate' };
  const endpoint = await loadEndpoint(delivery.endpointId);
  const settle = (set: Partial<WebhookDeliveryDoc>) =>
    WebhookDeliveryModel.updateOne({ _id: delivery._id }, { $set: set });
  if (!endpoint) {
    await settle({ status: 'gave_up', error: 'endpoint_deleted', nextAttemptAt: null });
    return { status: 'gave_up' };
  }
  if (!endpoint.active && !data.replay) {
    await settle({ status: 'failed', error: 'endpoint_disabled', nextAttemptAt: null });
    return { status: 'failed' };
  }
  const event = await WebhookEventModel.findById(delivery.eventId).lean();
  if (!event) {
    await settle({ status: 'gave_up', error: 'event_expired', nextAttemptAt: null });
    return { status: 'gave_up' };
  }
  const raw = payloadOf(
    {
      id: event._id,
      type: event.type,
      createdAt: event.createdAt,
      accountId: event.accountId.toString(),
      data: event.data,
    },
    endpoint.includePersonalData,
  );
  const result = await sendSigned(rt, endpoint, event._id, raw);
  const at = nowOf(rt);
  const delays = WEBHOOK_LIMITS.retryDelaysSec;
  const retryIn = !result.ok && !data.replay ? delays[data.attempt - 1] : undefined;
  const status: WebhookDeliveryDoc['status'] = result.ok
    ? 'succeeded'
    : retryIn !== undefined
      ? 'pending'
      : data.replay
        ? 'failed'
        : 'gave_up';
  // compare-and-set on the attempt count: a parallel run of the same attempt loses
  const updated = await WebhookDeliveryModel.updateOne(
    { _id: delivery._id, attempt: data.attempt - 1 },
    {
      $set: {
        status,
        attempt: data.attempt,
        lastAttemptAt: at,
        nextAttemptAt: retryIn !== undefined ? new Date(at.getTime() + retryIn * 1000) : null,
        responseStatus: result.responseStatus,
        responseMs: result.responseMs,
        responseSnippet: result.responseSnippet,
        error: result.error,
      },
      $push: {
        attempts: {
          $each: [
            {
              attempt: data.attempt,
              at,
              ok: result.ok,
              responseStatus: result.responseStatus,
              responseMs: result.responseMs,
              error: result.error,
            },
          ],
          $slice: -MAX_ATTEMPT_ROWS,
        },
      },
    },
  );
  if (!updated.modifiedCount) return { status: 'duplicate' };
  if (retryIn !== undefined) {
    await getWebhookJobs().enqueueDelivery(
      delivery._id.toString(),
      data.attempt + 1,
      retryIn * 1000,
    );
  }
  if (result.ok) {
    await WebhookEndpointModel.updateOne(
      { _id: endpoint._id },
      {
        $set: {
          failureStreak: 0,
          failingSince: null,
          lastDeliveryAt: at,
          lastDeliveryStatus: 'succeeded',
        },
      },
    );
  } else {
    await WebhookEndpointModel.updateOne(
      { _id: endpoint._id },
      { $set: { lastDeliveryAt: at, lastDeliveryStatus: 'failed' } },
    );
    await WebhookEndpointModel.updateOne(
      { _id: endpoint._id, failingSince: null },
      { $set: { failingSince: at } },
    );
    if (status === 'gave_up') {
      const after = await WebhookEndpointModel.findOneAndUpdate(
        { _id: endpoint._id },
        { $inc: { failureStreak: 1 } },
        { new: true },
      ).lean<WebhookEndpointDoc>();
      if (after && after.failureStreak >= WEBHOOK_LIMITS.disableAfterGivenUp) {
        await disableEndpoint(rt, endpoint, 'failing', { givenUp: after.failureStreak });
      }
    }
  }
  getLogger().info(
    {
      deliveryId: delivery._id.toString(),
      attempt: data.attempt,
      status,
      responseStatus: result.responseStatus,
    },
    'webhooks: delivery attempt',
  );
  return { status };
};

/**
 * Maintenance `webhook-health` (every 10 min): endpoints failing for 24 h with no
 * success in between are turned off.
 */
export const checkWebhookHealth = async (rt: WebhookRuntime): Promise<{ disabled: number }> => {
  const cutoff = new Date(
    nowOf(rt).getTime() - WEBHOOK_LIMITS.disableAfterFailingHours * 3_600_000,
  );
  const failing = await WebhookEndpointModel.find({
    active: true,
    failingSince: { $ne: null, $lte: cutoff },
  })
    .select({ _id: 1, accountId: 1, url: 1, description: 1 })
    .lean();
  let disabled = 0;
  for (const e of failing) {
    if (
      await disableEndpoint(rt, e, 'failing', {
        failingHours: WEBHOOK_LIMITS.disableAfterFailingHours,
      })
    )
      disabled += 1;
  }
  return { disabled };
};
