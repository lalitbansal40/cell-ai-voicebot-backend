import type { Request } from 'express';
import { Types } from 'mongoose';

import type { Env } from '../../config/env';
import {
  AccountModel,
  DEFAULT_ACCOUNT_WHATSAPP,
  type AccountDoc,
} from '../../db/models/account.model';
import {
  MetaWebhookEventModel,
  type MetaEventStatus,
} from '../../db/models/meta-webhook-event.model';
import {
  WhatsAppChannelModel,
  type MetaPayer,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { recordAudit } from '../audit/audit.service';

import { auditChannel, type WaActor } from './channel-status';
import type { WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import type { WhatsAppService } from './whatsapp.service';

export interface WhatsAppAdminDeps {
  ctx: WhatsAppContext;
  jobs: WhatsAppJobs;
  service: WhatsAppService;
}

const DAY = 86_400_000;

/** The superadmin acting (platform account), for audits and channel actions. */
export const platformActor = (req: Request): WaActor => {
  const auth = requireAuth(req);
  return {
    type: 'user',
    id: new Types.ObjectId(auth.userId ?? undefined),
    platform: true,
    ip: req.ip ?? null,
  };
};

const customerAccount = async (id: string): Promise<AccountDoc> => {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError();
  const account = await AccountModel.findById(id).lean<AccountDoc>();
  if (!account) throw new NotFoundError();
  if (account.isPlatform) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'The platform account cannot be managed here.',
    );
  }
  return account;
};

/** Booleans only for secrets — never values. */
export const whatsappStatus = async (env: Env) => {
  const since = new Date(Date.now() - DAY);
  const [byStatus, events, last] = await Promise.all([
    WhatsAppChannelModel.aggregate<{ _id: string; n: number }>([
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    MetaWebhookEventModel.aggregate<{ _id: string; n: number }>([
      { $match: { receivedAt: { $gte: since } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    MetaWebhookEventModel.findOne({}, { receivedAt: 1 })
      .sort({ receivedAt: -1 })
      .lean<{ receivedAt: Date }>(),
  ]);
  const fake = env.META_PROVIDER === 'fake';
  return {
    enabled: env.WHATSAPP_ENABLED,
    provider: env.META_PROVIDER,
    graphVersion: env.META_GRAPH_VERSION,
    configured: {
      appId: Boolean(env.META_APP_ID),
      appSecret: fake ? Boolean(env.FAKE_META_APP_SECRET) : Boolean(env.META_APP_SECRET),
      configId: Boolean(env.META_ES_CONFIG_ID),
      verifyToken: Boolean(env.META_WEBHOOK_VERIFY_TOKEN),
      creditLine: fake || Boolean(env.META_CREDIT_LINE_ID),
      systemUserToken: fake || Boolean(env.META_SYSTEM_USER_TOKEN),
    },
    webhookUrl: `${env.APP_URL.replace(/\/+$/, '')}/api/v1/webhooks/meta`,
    deauthorizeUrl: `${env.APP_URL.replace(/\/+$/, '')}/api/v1/meta/deauthorize`,
    dataDeletionUrl: `${env.APP_URL.replace(/\/+$/, '')}/api/v1/meta/data-deletion`,
    lastEventAt: last ? last.receivedAt.toISOString() : null,
    channelsByStatus: Object.fromEntries(byStatus.map((r) => [r._id, r.n])),
    eventsByStatus24h: Object.fromEntries(events.map((r) => [r._id, r.n])),
  };
};

/** Webhook events — metadata only (never payloads). */
export const listEvents = async (query: { status?: MetaEventStatus; limit?: number }) => {
  const rows = await MetaWebhookEventModel.find(query.status ? { status: query.status } : {})
    .sort({ receivedAt: -1, _id: -1 })
    .limit(query.limit ?? 50)
    .lean<
      {
        _id: Types.ObjectId;
        field: string;
        status: MetaEventStatus;
        attempts: number;
        error: string | null;
        wabaId: string | null;
        phoneNumberId: string | null;
        accountId: Types.ObjectId | null;
        channelId: Types.ObjectId | null;
        receivedAt: Date;
        processedAt: Date | null;
      }[]
    >();
  return rows.map((r) => ({
    id: r._id.toString(),
    field: r.field,
    status: r.status,
    attempts: r.attempts,
    error: r.error,
    wabaId: r.wabaId,
    phoneNumberId: r.phoneNumberId,
    accountId: r.accountId?.toString() ?? null,
    channelId: r.channelId?.toString() ?? null,
    receivedAt: r.receivedAt.toISOString(),
    processedAt: r.processedAt ? r.processedAt.toISOString() : null,
  }));
};

/** Failed (or ignored) events go back to `received` and into the queue. */
export const replayEvent = async (req: Request, deps: WhatsAppAdminDeps, id: string) => {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Event not found');
  const event = await MetaWebhookEventModel.findOneAndUpdate(
    { _id: id, status: { $in: ['failed', 'ignored'] } },
    { $set: { status: 'received', error: null, attempts: 0, processedAt: null } },
    { returnDocument: 'after' },
  ).lean<{ _id: Types.ObjectId; field: string }>();
  if (!event) {
    if (await MetaWebhookEventModel.exists({ _id: id })) {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'Only failed or ignored events can be replayed.',
      );
    }
    throw new NotFoundError('Event not found');
  }
  await deps.jobs.enqueueEvent(event._id.toString());
  const auth = requireAuth(req);
  await recordAudit({
    accountId: auth.accountId,
    actor: { type: 'user', id: auth.userId ?? null, platform: true },
    action: 'whatsapp.event_replayed',
    target: { type: 'meta_webhook_event', id: event._id.toString() },
    meta: { field: event.field },
    ip: req.ip ?? null,
  });
  return { id: event._id.toString(), status: 'received' as const };
};

/** Summary rows for the superadmin account detail (no secrets). */
export const accountWhatsApp = async (accountId: Types.ObjectId) => {
  const [account, channels] = await Promise.all([
    AccountModel.findById(accountId)
      .select({ whatsapp: 1 })
      .lean<{ whatsapp?: { metaPayer?: MetaPayer } }>(),
    WhatsAppChannelModel.find({ accountId }).sort({ createdAt: -1 }).lean<WhatsAppChannelDoc[]>(),
  ]);
  return {
    whatsappBilling: {
      metaPayer: account?.whatsapp?.metaPayer ?? DEFAULT_ACCOUNT_WHATSAPP.metaPayer,
    },
    whatsappChannels: channels.map((c) => ({
      id: c._id.toString(),
      label: c.label,
      status: c.status,
      mode: c.mode,
      displayPhoneNumber: c.displayPhoneNumber,
      verifiedName: c.verifiedName,
      qualityRating: c.qualityRating,
      messagingLimitTier: c.messagingLimitTier,
      metaPayer: c.metaPayer,
      creditLineStatus: c.creditLine.status,
      connectedAt: c.connectedAt ? c.connectedAt.toISOString() : null,
    })),
  };
};

/** Who pays Meta for numbers connected from now on (audited in both accounts). */
export const setWhatsAppBilling = async (req: Request, accountId: string, metaPayer: MetaPayer) => {
  const account = await customerAccount(accountId);
  const from = account.whatsapp?.metaPayer ?? DEFAULT_ACCOUNT_WHATSAPP.metaPayer;
  await AccountModel.updateOne({ _id: account._id }, { $set: { 'whatsapp.metaPayer': metaPayer } });
  if (from !== metaPayer) {
    const auth = requireAuth(req);
    const base = {
      actor: { type: 'user' as const, id: auth.userId ?? null, platform: true },
      action: 'whatsapp.billing_mode_changed' as const,
      target: { type: 'account', id: account._id.toString() },
      meta: { from, to: metaPayer },
      ip: req.ip ?? null,
    };
    await recordAudit({ ...base, accountId: account._id });
    await recordAudit({ ...base, accountId: auth.accountId });
  }
  return { metaPayer };
};

/** Force disconnect with a reason (notification + email to owners / admins, audit both sides). */
export const adminDisconnect = async (
  req: Request,
  deps: WhatsAppAdminDeps,
  channelId: string,
  reason: string,
) => {
  if (!Types.ObjectId.isValid(channelId)) throw new NotFoundError('WhatsApp number not found');
  const channel = await WhatsAppChannelModel.findById(channelId).lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  const actor = platformActor(req);
  const view = await deps.service.disconnect(channel.accountId, channelId, actor, {
    byAdminReason: reason,
  });
  await auditChannel(
    { ...channel, status: 'disconnected' },
    'whatsapp.channel_disconnected',
    actor,
    { byAdmin: true, reason, accountId: channel.accountId.toString() },
    new Types.ObjectId(requireAuth(req).accountId),
  );
  return view;
};

/** Manual connect (platform test number): a System User token instead of a signup code. */
export const manualConnect = async (
  req: Request,
  deps: WhatsAppAdminDeps,
  accountId: string,
  input: { wabaId: string; phoneNumberId: string; accessToken: string },
) => {
  const account = await customerAccount(accountId);
  if (account.status !== 'active') throw new AppError('AUTH_ACCOUNT_SUSPENDED');
  return deps.service.connect({
    accountId: account._id,
    actor: platformActor(req),
    mode: 'cloud_api',
    accessToken: input.accessToken,
    manual: true,
    sessionInfo: { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId },
  });
};
