import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { WEBHOOK_LIMITS } from '../../config/limits';
import {
  WebhookDeliveryModel,
  type WebhookDeliveryDoc,
} from '../../db/models/webhook-delivery.model';
import {
  WebhookEndpointModel,
  type WebhookEndpointDoc,
} from '../../db/models/webhook-endpoint.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { seal } from '../../shared/crypto/secret-box';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { resolvePublicAddress } from '../../shared/net/url-guard';
import { auditRequest } from '../audit/audit.service';

import { hostOf, payloadOf, sendSigned, type WebhookRuntime } from './deliver.job';
import type { CreateEndpointBody, DeliveriesQuery, UpdateEndpointBody } from './endpoints.schema';
import { newEventId, type WebhookEventType } from './events';
import { getWebhookJobs } from './jobs';
import { SAMPLE_DATA } from './samples';
import { newWebhookSecret } from './signing';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export const endpointView = (e: WebhookEndpointDoc) => ({
  id: e._id.toString(),
  url: e.url,
  description: e.description,
  events: [...e.events],
  includePersonalData: e.includePersonalData,
  active: e.active,
  disabledReason: e.disabledReason,
  disabledAt: iso(e.disabledAt),
  failureStreak: e.failureStreak,
  lastDeliveryAt: iso(e.lastDeliveryAt),
  lastDeliveryStatus: e.lastDeliveryStatus,
  rotatedAt: iso(e.rotatedAt),
  createdAt: e.createdAt.toISOString(),
});

export const deliveryView = (d: WebhookDeliveryDoc) => ({
  id: d._id.toString(),
  endpointId: d.endpointId.toString(),
  eventId: d.eventId,
  type: d.type,
  test: d.test,
  status: d.status,
  attempt: d.attempt,
  nextAttemptAt: iso(d.nextAttemptAt),
  lastAttemptAt: iso(d.lastAttemptAt),
  responseStatus: d.responseStatus,
  responseMs: d.responseMs,
  responseSnippet: d.responseSnippet,
  error: d.error,
  attempts: (d.attempts ?? []).map((a) => ({
    attempt: a.attempt,
    at: a.at.toISOString(),
    ok: a.ok,
    responseStatus: a.responseStatus,
    responseMs: a.responseMs,
    error: a.error,
  })),
  createdAt: d.createdAt.toISOString(),
});

const BLOCK_MESSAGES: Record<string, string> = {
  scheme: 'Use an https address',
  port: 'This port is not allowed',
  invalid: 'Addresses with a user name or password are not allowed',
  private: 'Private, local and cloud-metadata addresses are not allowed',
  reserved: 'Private, local and cloud-metadata addresses are not allowed',
  network: 'This address could not be found',
};

/** The URL guard at save: scheme, credentials, literal IPs, then DNS (every address checked). */
const assertWebhookUrl = async (rt: WebhookRuntime, raw: string): Promise<string> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('WEBHOOK_URL_BLOCKED', undefined, [
      { path: 'url', message: 'Not a valid address' },
    ]);
  }
  const r = await resolvePublicAddress(url, rt.policy, rt);
  if (!r.ok) {
    throw new AppError('WEBHOOK_URL_BLOCKED', undefined, [
      { path: 'url', message: BLOCK_MESSAGES[r.reason] ?? 'This address is not allowed' },
    ]);
  }
  return url.toString();
};

const findEndpoint = async (req: Request, id: string): Promise<WebhookEndpointDoc> => {
  const _id = toObjectId(id);
  const e = _id
    ? await WebhookEndpointModel.findOne({ _id, ...tenantFilter(req) }).lean<WebhookEndpointDoc>()
    : null;
  if (!e) throw new NotFoundError('Webhook not found');
  return e;
};

const target = (id: string) => ({ type: 'webhook_endpoint', id });

export const listEndpoints = async (req: Request) =>
  (
    await WebhookEndpointModel.find(tenantFilter(req))
      .sort({ createdAt: -1 })
      .lean<WebhookEndpointDoc[]>()
  ).map(endpointView);

export const getEndpoint = async (req: Request, id: string) =>
  endpointView(await findEndpoint(req, id));

export const createEndpoint = async (
  rt: WebhookRuntime,
  req: Request,
  body: z.infer<typeof CreateEndpointBody>,
) => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  if (
    (await WebhookEndpointModel.countDocuments({ accountId })) >= WEBHOOK_LIMITS.endpointsPerAccount
  ) {
    throw new AppError('WEBHOOK_ENDPOINT_LIMIT');
  }
  const url = await assertWebhookUrl(rt, body.url);
  const secret = newWebhookSecret();
  const created = await WebhookEndpointModel.create({
    accountId,
    url,
    description: body.description ?? '',
    events: body.events,
    secretSealed: seal(rt.key, secret),
    includePersonalData: body.includePersonalData ?? false,
    createdBy: auth.userId
      ? new Types.ObjectId(auth.userId)
      : auth.keyOwnerId
        ? new Types.ObjectId(auth.keyOwnerId)
        : null,
  });
  const endpoint = endpointView(created.toObject({ transform: false }));
  await auditRequest(req, 'webhook_endpoint.created', {
    target: target(endpoint.id),
    meta: {
      host: hostOf(url),
      events: body.events,
      includePersonalData: endpoint.includePersonalData,
    },
  });
  return { endpoint, secret };
};

export const updateEndpoint = async (
  rt: WebhookRuntime,
  req: Request,
  id: string,
  body: z.infer<typeof UpdateEndpointBody>,
) => {
  const current = await findEndpoint(req, id);
  const set: Record<string, unknown> = {};
  if (body.url !== undefined) set.url = await assertWebhookUrl(rt, body.url);
  if (body.description !== undefined) set.description = body.description;
  if (body.events !== undefined) set.events = body.events;
  if (body.includePersonalData !== undefined) set.includePersonalData = body.includePersonalData;
  if (body.active === false && current.active) {
    Object.assign(set, { active: false, disabledReason: 'manual', disabledAt: new Date() });
  }
  const updated = await WebhookEndpointModel.findOneAndUpdate(
    { _id: current._id, accountId: current.accountId },
    { $set: set },
    { new: true },
  ).lean<WebhookEndpointDoc>();
  if (!updated) throw new NotFoundError('Webhook not found');
  await auditRequest(req, 'webhook_endpoint.updated', {
    target: target(id),
    meta: {
      host: hostOf(updated.url),
      changed: Object.keys(body),
      events: updated.events,
      includePersonalData: updated.includePersonalData,
    },
  });
  return endpointView(updated);
};

export const deleteEndpoint = async (req: Request, id: string) => {
  const e = await findEndpoint(req, id);
  await WebhookEndpointModel.deleteOne({ _id: e._id, accountId: e.accountId });
  // pending retries stop: their next job finds no endpoint and gives up
  await auditRequest(req, 'webhook_endpoint.deleted', {
    target: target(id),
    meta: { host: hostOf(e.url) },
  });
};

/** New secret, shown once; the previous one keeps signing for the 24 h overlap. */
export const rotateSecret = async (rt: WebhookRuntime, req: Request, id: string) => {
  const e = await findEndpoint(req, id);
  const withSecret = await WebhookEndpointModel.findById(e._id)
    .select('+secretSealed')
    .lean<WebhookEndpointDoc>();
  const secret = newWebhookSecret();
  const updated = await WebhookEndpointModel.findOneAndUpdate(
    { _id: e._id, accountId: e.accountId },
    {
      $set: {
        secretSealed: seal(rt.key, secret),
        secretPreviousSealed: withSecret?.secretSealed ?? null,
        rotatedAt: rt.now?.() ?? new Date(),
      },
    },
    { new: true },
  ).lean<WebhookEndpointDoc>();
  await auditRequest(req, 'webhook_endpoint.secret_rotated', {
    target: target(id),
    meta: { host: hostOf(e.url) },
  });
  return { endpoint: endpointView(updated as WebhookEndpointDoc), secret };
};

export const enableEndpoint = async (req: Request, id: string) => {
  const e = await findEndpoint(req, id);
  const updated = await WebhookEndpointModel.findOneAndUpdate(
    { _id: e._id, accountId: e.accountId },
    {
      $set: {
        active: true,
        disabledReason: null,
        disabledAt: null,
        failureStreak: 0,
        failingSince: null,
      },
    },
    { new: true },
  ).lean<WebhookEndpointDoc>();
  if (!e.active) {
    await auditRequest(req, 'webhook_endpoint.enabled', {
      target: target(id),
      meta: { host: hostOf(e.url) },
    });
  }
  return endpointView(updated as WebhookEndpointDoc);
};

/**
 * "Send test event": a sample payload of `type`, signed and posted now; the answer is
 * returned and logged as a test delivery (never retried, never counted as a failure).
 */
export const sendTestEvent = async (
  rt: WebhookRuntime,
  req: Request,
  id: string,
  type: WebhookEventType,
) => {
  const e = await findEndpoint(req, id);
  const endpoint = await WebhookEndpointModel.findById(e._id)
    .select('+secretSealed +secretPreviousSealed')
    .lean<WebhookEndpointDoc>();
  const at = rt.now?.() ?? new Date();
  const eventId = newEventId(at.getTime());
  const raw = payloadOf(
    {
      id: eventId,
      type,
      createdAt: at,
      accountId: e.accountId.toString(),
      data: SAMPLE_DATA[type],
    },
    e.includePersonalData,
  );
  const result = await sendSigned(rt, endpoint as WebhookEndpointDoc, eventId, raw);
  const delivery = await WebhookDeliveryModel.create({
    accountId: e.accountId,
    endpointId: e._id,
    eventId,
    type,
    test: true,
    status: result.ok ? 'succeeded' : 'failed',
    attempt: 1,
    lastAttemptAt: at,
    responseStatus: result.responseStatus,
    responseMs: result.responseMs,
    responseSnippet: result.responseSnippet,
    error: result.error,
    attempts: [
      {
        attempt: 1,
        at,
        ok: result.ok,
        responseStatus: result.responseStatus,
        responseMs: result.responseMs,
        error: result.error,
      },
    ],
  });
  return {
    ok: result.ok,
    delivery: deliveryView(delivery.toObject()),
  };
};

export const listDeliveries = async (
  req: Request,
  id: string,
  q: z.infer<typeof DeliveriesQuery>,
) => {
  const e = await findEndpoint(req, id);
  const at: Record<string, Date> = {};
  if (q.from) at.$gte = new Date(q.from);
  if (q.to) at.$lt = new Date(q.to);
  const rows = await WebhookDeliveryModel.find({
    accountId: e.accountId,
    endpointId: e._id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(Object.keys(at).length ? { createdAt: at } : {}),
    ...(q.cursor ? { _id: { $lt: new Types.ObjectId(q.cursor) } } : {}),
  })
    .sort({ _id: -1 })
    .limit(q.limit + 1)
    .lean<WebhookDeliveryDoc[]>();
  const page = rows.slice(0, q.limit);
  return {
    items: page.map(deliveryView),
    nextCursor: rows.length > q.limit ? (page.at(-1)?._id.toString() ?? null) : null,
  };
};

/** Replay: one more attempt now, same event id (test deliveries are re-sent with "Send test"). */
export const replayDelivery = async (req: Request, id: string) => {
  const _id = toObjectId(id);
  const d = _id
    ? await WebhookDeliveryModel.findOne({ _id, ...tenantFilter(req) }).lean<WebhookDeliveryDoc>()
    : null;
  if (!d) throw new NotFoundError('Delivery not found');
  if (d.test) throw new ConflictError('CONFLICT_INVALID_STATE', 'Send a new test event instead.');
  if (d.status === 'pending') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This delivery is already scheduled.');
  }
  await WebhookDeliveryModel.updateOne(
    { _id: d._id },
    { $set: { status: 'pending', nextAttemptAt: new Date() } },
  );
  await getWebhookJobs().enqueueDelivery(d._id.toString(), d.attempt + 1, 0, true);
  const after = await WebhookDeliveryModel.findById(d._id).lean<WebhookDeliveryDoc>();
  return deliveryView(after as WebhookDeliveryDoc);
};
