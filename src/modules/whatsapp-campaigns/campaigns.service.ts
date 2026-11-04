import type { Request } from 'express';
import { Types } from 'mongoose';

import type { PriceCategory } from '../../core/billing/whatsapp';
import { ContactModel } from '../../db/models/contact.model';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { MessageModel } from '../../db/models/message.model';
import { WalletModel, type WalletDoc } from '../../db/models/wallet.model';
import {
  WhatsAppCampaignRecipientModel,
  type WhatsAppCampaignRecipientDoc,
} from '../../db/models/whatsapp-campaign-recipient.model';
import {
  WhatsAppCampaignModel,
  emptyCounters,
  type WaRecipientFilter,
  type WhatsAppCampaignDoc,
} from '../../db/models/whatsapp-campaign.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { priceMessage } from '../whatsapp-billing/pricing.service';

import { audienceFilter, snapshotAudience, toObjectIds } from './audience';
import { loadVariants } from './dispatch';
import { emitProgress } from './tracking';

export interface WaCampaignJobs {
  enqueueDispatch(campaignId: string): Promise<void>;
}

export interface CampaignInput {
  name: string;
  channelId: string;
  variants: { key: 'A' | 'B' | 'C'; templateId: string; splitPct: number }[];
  abWinner?: { metric: 'read' | 'reply'; afterHours: number } | null | undefined;
  variables?:
    | Record<
        string,
        {
          kind: 'field' | 'contact.name' | 'contact.phone' | 'static';
          value?: string | null | undefined;
        }
      >
    | undefined;
  audience: {
    listIds?: string[] | undefined;
    segmentId?: string | null | undefined;
    tags?: { values: string[]; mode: 'any' | 'all' } | null | undefined;
    contactIds?: string[] | undefined;
    csvUploadId?: string | null | undefined;
  };
  excludeRecentDays?: number | undefined;
  schedule?: { kind: 'now' | 'at'; at?: string | null | undefined } | undefined;
}

const EDITABLE = ['draft', 'scheduled'] as const;

const view = (c: WhatsAppCampaignDoc) => ({
  id: c._id.toString(),
  name: c.name,
  channelId: c.channelId.toString(),
  status: c.status,
  pauseReason: c.pauseReason,
  variants: c.variants.map((v) => ({
    key: v.key,
    templateId: v.templateId.toString(),
    splitPct: v.splitPct,
  })),
  abWinner: c.abWinner
    ? { ...c.abWinner, decidedAt: c.abWinner.decidedAt?.toISOString() ?? null }
    : null,
  variables: c.variables,
  audience: {
    listIds: c.audience.listIds.map(String),
    segmentId: c.audience.segmentId ? c.audience.segmentId.toString() : null,
    tags: c.audience.tags,
    contactIds: c.audience.contactIds.map(String),
    csvUploadId: c.audience.csvUploadId ? c.audience.csvUploadId.toString() : null,
  },
  excludeRecentDays: c.excludeRecentDays,
  schedule: { kind: c.schedule.kind, at: c.schedule.at?.toISOString() ?? null },
  counters: { ...emptyCounters(), ...c.counters },
  cost: c.cost,
  nextBatchAt: c.nextBatchAt?.toISOString() ?? null,
  startedAt: c.startedAt?.toISOString() ?? null,
  finishedAt: c.finishedAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
  updatedAt: c.updatedAt.toISOString(),
});
export type WaCampaignView = ReturnType<typeof view>;

const audit = async (
  req: Request,
  c: Pick<WhatsAppCampaignDoc, '_id' | 'accountId'>,
  action: AuditAction,
  meta: Record<string, unknown> = {},
) => {
  const auth = requireAuth(req);
  await recordAudit({
    accountId: c.accountId,
    actor: { type: 'user', id: auth.userId ?? null, impersonatorId: auth.impersonatorId ?? null },
    action,
    target: { type: 'whatsapp_campaign', id: c._id.toString() },
    meta,
    ip: req.ip ?? null,
  });
};

const load = async (req: Request, id: string): Promise<WhatsAppCampaignDoc> => {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Campaign not found');
  const c = await WhatsAppCampaignModel.findOne({
    _id: new Types.ObjectId(id),
    ...tenantFilter(req),
  }).lean<WhatsAppCampaignDoc>();
  if (!c) throw new NotFoundError('Campaign not found');
  return c;
};

/** Validates the number and the variants (approved templates of the number's WABA). */
const validate = async (accountId: Types.ObjectId, input: CampaignInput) => {
  const channel = Types.ObjectId.isValid(input.channelId)
    ? await WhatsAppChannelModel.findOne({
        _id: new Types.ObjectId(input.channelId),
        accountId,
      }).lean<WhatsAppChannelDoc>()
    : null;
  if (!channel)
    throw new ValidationError([{ path: 'channelId', message: 'Unknown WhatsApp number' }]);
  const total = input.variants.reduce((a, v) => a + v.splitPct, 0);
  if (total !== 100)
    throw new ValidationError([{ path: 'variants', message: 'The split must add up to 100' }]);
  const keys = input.variants.map((v) => v.key);
  if (new Set(keys).size !== keys.length)
    throw new ValidationError([{ path: 'variants', message: 'Each variant once' }]);
  const variants = await loadVariants(
    {
      accountId,
      variants: input.variants.map((v) => ({ ...v, templateId: new Types.ObjectId(v.templateId) })),
    },
    channel.wabaId,
  );
  input.variants.forEach((v, i) => {
    const found = variants.find((x) => x.key === v.key);
    if (!found || found.status !== 'APPROVED') {
      throw new ValidationError([
        {
          path: `variants.${String(i)}.templateId`,
          message: 'Pick an approved template of this number',
        },
      ]);
    }
  });
  const needed = new Set(variants.flatMap((v) => v.keys));
  for (const k of needed) {
    const src = input.variables?.[k];
    if (!src || (src.kind === 'static' || src.kind === 'field' ? !src.value?.trim() : false)) {
      throw new ValidationError([
        { path: `variables.${k}`, message: 'Say where this value comes from' },
      ]);
    }
  }
  return { channel, variants };
};

const toDoc = (input: CampaignInput) => ({
  name: input.name,
  channelId: new Types.ObjectId(input.channelId),
  variants: input.variants.map((v) => ({ ...v, templateId: new Types.ObjectId(v.templateId) })),
  abWinner:
    input.variants.length > 1 && input.abWinner
      ? {
          metric: input.abWinner.metric,
          afterHours: input.abWinner.afterHours,
          decidedAt: null,
          winner: null,
        }
      : null,
  variables: Object.fromEntries(
    Object.entries(input.variables ?? {}).map(([k, v]) => [
      k,
      { kind: v.kind, value: v.value ?? null },
    ]),
  ),
  audience: {
    listIds: toObjectIds(input.audience.listIds ?? []),
    segmentId: input.audience.segmentId ? new Types.ObjectId(input.audience.segmentId) : null,
    tags: input.audience.tags?.values.length ? input.audience.tags : null,
    contactIds: toObjectIds(input.audience.contactIds ?? []),
    csvUploadId: input.audience.csvUploadId ? new Types.ObjectId(input.audience.csvUploadId) : null,
  },
  excludeRecentDays: input.excludeRecentDays ?? 0,
  schedule: {
    kind: input.schedule?.kind ?? 'now',
    at: input.schedule?.at ? new Date(input.schedule.at) : null,
  },
});

export const createCampaign = async (req: Request, input: CampaignInput) => {
  const { accountId } = tenantFilter(req);
  const auth = requireAuth(req);
  await validate(accountId, input);
  const c = await WhatsAppCampaignModel.create({
    accountId,
    createdBy: new Types.ObjectId(auth.userId),
    ...toDoc(input),
  });
  await audit(req, c, 'whatsapp_campaign.created', {
    channelId: input.channelId,
    variants: input.variants.length,
  });
  return view(c.toObject({ transform: false }));
};

export const listCampaigns = async (
  req: Request,
  q: { page: number; limit: number; status?: WhatsAppCampaignDoc['status'] | undefined },
) => {
  const filter = { ...tenantFilter(req), ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    WhatsAppCampaignModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<WhatsAppCampaignDoc[]>(),
    WhatsAppCampaignModel.countDocuments(filter),
  ]);
  return {
    data: rows.map(view),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

export const getCampaign = async (req: Request, id: string) => view(await load(req, id));

export const updateCampaign = async (req: Request, id: string, input: CampaignInput) => {
  const c = await load(req, id);
  if (!(EDITABLE as readonly string[]).includes(c.status))
    throw new AppError('WA_CAMPAIGN_NOT_EDITABLE');
  await validate(c.accountId, input);
  const updated = await WhatsAppCampaignModel.findOneAndUpdate(
    { _id: c._id, status: { $in: [...EDITABLE] } },
    { $set: toDoc(input) },
    { returnDocument: 'after' },
  ).lean<WhatsAppCampaignDoc>();
  if (!updated) throw new AppError('WA_CAMPAIGN_NOT_EDITABLE');
  return view(updated);
};

export const deleteCampaign = async (req: Request, id: string) => {
  const c = await load(req, id);
  if (c.status !== 'draft') throw new AppError('WA_CAMPAIGN_NOT_EDITABLE');
  await WhatsAppCampaignModel.deleteOne({ _id: c._id, status: 'draft' });
  await WhatsAppCampaignRecipientModel.deleteMany({ campaignId: c._id });
};

/** Cost before sending: recipients by market × price of each variant's category; wallet check. */
export const estimateCampaign = async (req: Request, id: string) => {
  const c = await load(req, id);
  const channel = await WhatsAppChannelModel.findById(c.channelId).lean<WhatsAppChannelDoc>();
  if (!channel)
    throw new ValidationError([{ path: 'channelId', message: 'Unknown WhatsApp number' }]);
  const variants = await loadVariants(c, channel.wabaId);
  // a dry snapshot: count without writing rows
  const filter = await audienceFilter(c);
  const contacts = await ContactModel.find(filter)
    .select({ phoneE164: 1 })
    .limit(100_000)
    .lean<{ phoneE164: string }[]>();
  const priceCache = new Map<string, { market: string; priceMicros: number }>();
  const byMarket = new Map<string, { count: number; priceMicros: number }>();
  const category = (variants[0]?.category ?? 'MARKETING').toLowerCase() as PriceCategory;
  let totalMicros = 0;
  for (const ct of contacts) {
    const key = ct.phoneE164.slice(0, 5);
    let q = priceCache.get(key);
    if (!q) {
      try {
        const quote = await priceMessage({
          accountId: c.accountId,
          payer: channel.metaPayer,
          phoneE164: ct.phoneE164,
          category,
        });
        q = { market: quote.market, priceMicros: quote.priceMicros };
      } catch {
        q = { market: 'OTHER', priceMicros: 0 };
      }
      priceCache.set(key, q);
    }
    const m = byMarket.get(q.market) ?? { count: 0, priceMicros: q.priceMicros };
    m.count += 1;
    byMarket.set(q.market, m);
    totalMicros += q.priceMicros;
  }
  const wallet = await WalletModel.findOne({ accountId: c.accountId }).lean<WalletDoc>();
  const available = wallet
    ? wallet.balanceMicros - wallet.holdMicros + wallet.creditLimitMicros
    : 0;
  await WhatsAppCampaignModel.updateOne(
    { _id: c._id },
    { $set: { 'cost.estimateMicros': totalMicros } },
  );
  return {
    recipients: contacts.length,
    byMarket: [...byMarket.entries()].map(([market, v]) => ({
      market,
      count: v.count,
      priceMicros: v.priceMicros,
    })),
    totalMicros,
    walletAvailableMicros: Math.max(0, available),
    enough: available >= totalMicros,
    note: 'Upper bound: contacts skipped at start (DND, opted out…) are not charged.',
  };
};

/** Snapshots the audience, checks the wallet, then runs now or at the scheduled time. */
export const startCampaign = async (req: Request, id: string, jobs?: WaCampaignJobs) => {
  const c = await load(req, id);
  if (!(EDITABLE as readonly string[]).includes(c.status)) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This campaign has already started.');
  }
  const channel = await WhatsAppChannelModel.findById(c.channelId).lean<WhatsAppChannelDoc>();
  if (!channel || channel.status !== 'connected') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Connect the WhatsApp number first.');
  }
  const variants = await loadVariants(c, channel.wabaId);
  const snap = await snapshotAudience(c, variants);
  const pending = await WhatsAppCampaignRecipientModel.countDocuments({
    campaignId: c._id,
    status: 'pending',
  });
  const skippedTotal = Object.values(snap.skipped).reduce((a, b) => a + (b ?? 0), 0);
  if (!pending) {
    await WhatsAppCampaignRecipientModel.deleteMany({ campaignId: c._id });
    throw new AppError('WA_CAMPAIGN_AUDIENCE_EMPTY', undefined, [
      { path: 'audience', message: JSON.stringify(snap.skipped) },
    ]);
  }
  const est = await estimateCampaign(req, id);
  const perMessage = est.recipients ? est.totalMicros / est.recipients : 0;
  const need = Math.round(perMessage * pending);
  if (est.walletAvailableMicros < need) {
    await WhatsAppCampaignRecipientModel.deleteMany({ campaignId: c._id });
    throw new AppError('WALLET_INSUFFICIENT_BALANCE', undefined, [
      { path: 'shortfallMicros', message: String(need - est.walletAvailableMicros) },
    ]);
  }
  const later = c.schedule.kind === 'at' && c.schedule.at && c.schedule.at.getTime() > Date.now();
  const now = new Date();
  const updated = await WhatsAppCampaignModel.findOneAndUpdate(
    { _id: c._id, status: { $in: [...EDITABLE] } },
    {
      $set: {
        status: later ? 'scheduled' : 'running',
        startedAt: later ? null : now,
        'counters.total': snap.total,
        'counters.skippedTotal': skippedTotal,
        'counters.skipped': snap.skipped,
        'cost.estimateMicros': need,
      },
    },
    { returnDocument: 'after' },
  ).lean<WhatsAppCampaignDoc>();
  if (!updated)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This campaign has already started.');
  await audit(req, updated, 'whatsapp_campaign.started', {
    recipients: pending,
    skipped: skippedTotal,
    estimateMicros: need,
  });
  if (!later) await jobs?.enqueueDispatch(updated._id.toString());
  await emitProgress(updated._id, true);
  return view(updated);
};

const move = async (
  req: Request,
  id: string,
  from: readonly WhatsAppCampaignDoc['status'][],
  set: Record<string, unknown>,
  action: AuditAction,
) => {
  const c = await load(req, id);
  const updated = await WhatsAppCampaignModel.findOneAndUpdate(
    { _id: c._id, status: { $in: [...from] } },
    { $set: set },
    { returnDocument: 'after' },
  ).lean<WhatsAppCampaignDoc>();
  if (!updated)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The campaign cannot do that now.');
  await audit(req, updated, action, set.pauseReason ? { reason: set.pauseReason } : {});
  await emitProgress(updated._id, true);
  return updated;
};

export const pauseCampaign = async (req: Request, id: string) =>
  view(
    await move(
      req,
      id,
      ['running', 'waiting_for_limit', 'scheduled'],
      { status: 'paused', pauseReason: 'user' },
      'whatsapp_campaign.paused',
    ),
  );

export const resumeCampaign = async (req: Request, id: string, jobs?: WaCampaignJobs) => {
  const updated = await move(
    req,
    id,
    ['paused'],
    { status: 'running', pauseReason: null, startedAt: new Date() },
    'whatsapp_campaign.resumed',
  );
  await jobs?.enqueueDispatch(updated._id.toString());
  return view(updated);
};

/** Stops for good: everyone not sent yet is skipped `stopped`. */
export const stopCampaign = async (req: Request, id: string) => {
  const updated = await move(
    req,
    id,
    ['running', 'waiting_for_limit', 'paused', 'scheduled'],
    { status: 'stopped', finishedAt: new Date(), nextBatchAt: null },
    'whatsapp_campaign.stopped',
  );
  const rest = await WhatsAppCampaignRecipientModel.updateMany(
    { campaignId: updated._id, status: { $in: ['pending', 'sending'] }, messageId: null },
    { $set: { status: 'skipped', skipReason: 'stopped', claimedAt: null } },
  );
  if (rest.modifiedCount) {
    await WhatsAppCampaignModel.updateOne(
      { _id: updated._id },
      {
        $inc: {
          'counters.skippedTotal': rest.modifiedCount,
          'counters.skipped.stopped': rest.modifiedCount,
        },
        $set: { 'counters.queued': 0 },
      },
    );
  }
  return view(
    (await WhatsAppCampaignModel.findById(updated._id).lean<WhatsAppCampaignDoc>()) ?? updated,
  );
};

/** Meta codes worth another try (rate limits, temporary errors). */
const RETRYABLE = new Set([130429, 131000, 131016, 131048, 131056, 2, 4, 80007]);

/** Failed recipients with a retryable code (or our send error) go out again, once per click. */
export const retryFailed = async (req: Request, id: string, jobs?: WaCampaignJobs) => {
  const c = await load(req, id);
  if (!['completed', 'paused', 'running', 'waiting_for_limit'].includes(c.status)) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Nothing to retry now.');
  }
  const rows = await WhatsAppCampaignRecipientModel.find({ campaignId: c._id, status: 'failed' })
    .select({ errorCode: 1, messageId: 1 })
    .lean<Pick<WhatsAppCampaignRecipientDoc, '_id' | 'errorCode' | 'messageId'>[]>();
  const retry = rows.filter((r) => r.errorCode === null || RETRYABLE.has(r.errorCode));
  if (!retry.length) return { retried: 0 };
  // a fresh message (new client id = the old one + attempt) — the old failed one stays in the chat
  await WhatsAppCampaignRecipientModel.updateMany(
    { _id: { $in: retry.map((r) => r._id) } },
    { $set: { status: 'pending', messageId: null, errorCode: null, claimedAt: null } },
  );
  await WhatsAppCampaignModel.updateOne(
    { _id: c._id },
    {
      $inc: { 'counters.failedTotal': -retry.length },
      $set: { status: 'running', pauseReason: null, finishedAt: null },
    },
  );
  await audit(req, c, 'whatsapp_campaign.retried', { count: retry.length });
  await jobs?.enqueueDispatch(c._id.toString());
  return { retried: retry.length };
};

export const listRecipients = async (
  req: Request,
  id: string,
  q: { page: number; limit: number; status?: WaRecipientFilter | undefined },
) => {
  const c = await load(req, id);
  const filter = { campaignId: c._id, ...(q.status ? { status: q.status } : {}) };
  const [rows, total] = await Promise.all([
    WhatsAppCampaignRecipientModel.find(filter)
      .sort({ _id: 1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<WhatsAppCampaignRecipientDoc[]>(),
    WhatsAppCampaignRecipientModel.countDocuments(filter),
  ]);
  const contacts = await ContactModel.find({ _id: { $in: rows.map((r) => r.contactId) } })
    .select({ name: 1, phoneE164: 1 })
    .lean<{ _id: Types.ObjectId; name: string | null; phoneE164: string }[]>();
  const byId = new Map(contacts.map((x) => [x._id.toString(), x]));
  const mask = (p: string) => `${p.slice(0, 3)}••••${p.slice(-4)}`;
  return {
    data: rows.map((r) => {
      const ct = byId.get(r.contactId.toString());
      return {
        contactId: r.contactId.toString(),
        name: ct?.name ?? null,
        phone: ct ? mask(ct.phoneE164) : null,
        variant: r.variant,
        status: r.status,
        skipReason: r.skipReason,
        errorCode: r.errorCode,
        sentAt: r.sentAt?.toISOString() ?? null,
        repliedAt: r.repliedAt?.toISOString() ?? null,
      };
    }),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

/** CSV of every recipient; phones masked unless the user may export contacts. */
export const exportRecipients = async (req: Request, id: string): Promise<string> => {
  const c = await load(req, id);
  const full = requireAuth(req).permissions.has('contacts.export');
  const lines = ['Contact,Phone,Variant,Status,Skip reason,Error code,Sent at,Replied at'];
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  let lastId: Types.ObjectId | null = null;
  for (;;) {
    const rows: WhatsAppCampaignRecipientDoc[] = await WhatsAppCampaignRecipientModel.find({
      campaignId: c._id,
      ...(lastId ? { _id: { $gt: lastId } } : {}),
    })
      .sort({ _id: 1 })
      .limit(1_000)
      .lean<WhatsAppCampaignRecipientDoc[]>();
    if (!rows.length) break;
    lastId = rows.at(-1)?._id ?? null;
    const contacts = await ContactModel.find({ _id: { $in: rows.map((r) => r.contactId) } })
      .select({ name: 1, phoneE164: 1 })
      .lean<{ _id: Types.ObjectId; name: string | null; phoneE164: string }[]>();
    const byId = new Map(contacts.map((x) => [x._id.toString(), x]));
    for (const r of rows) {
      const ct = byId.get(r.contactId.toString());
      const phone = ct
        ? full
          ? ct.phoneE164
          : `${ct.phoneE164.slice(0, 3)}••••${ct.phoneE164.slice(-4)}`
        : '';
      lines.push(
        [
          esc(ct?.name ?? ''),
          phone,
          r.variant,
          r.status,
          r.skipReason ?? '',
          r.errorCode === null ? '' : String(r.errorCode),
          r.sentAt?.toISOString() ?? '',
          r.repliedAt?.toISOString() ?? '',
        ].join(','),
      );
    }
  }
  return `${lines.join('\n')}\n`;
};

/** Funnel, cost (from the ledger), errors, per day and per variant. */
export const campaignReport = async (req: Request, id: string) => {
  const c = await load(req, id);
  const [perDay, variants, messageIds] = await Promise.all([
    WhatsAppCampaignRecipientModel.aggregate<{ _id: string; sent: number }>([
      { $match: { campaignId: c._id, sentAt: { $ne: null } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$sentAt' } },
          sent: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    WhatsAppCampaignRecipientModel.aggregate<{
      _id: string;
      sent: number;
      read: number;
      replied: number;
    }>([
      { $match: { campaignId: c._id, status: { $in: ['sent', 'delivered', 'read'] } } },
      {
        $group: {
          _id: '$variant',
          sent: { $sum: 1 },
          read: { $sum: { $cond: [{ $eq: ['$status', 'read'] }, 1, 0] } },
          replied: { $sum: { $cond: [{ $ne: ['$repliedAt', null] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    WhatsAppCampaignRecipientModel.distinct('messageId', {
      campaignId: c._id,
      messageId: { $ne: null },
    }),
  ]);
  let charged = 0;
  const ids = messageIds.map(String);
  for (let i = 0; i < ids.length; i += 5_000) {
    const rows = await LedgerEntryModel.aggregate<{ micros: number }>([
      {
        $match: {
          accountId: c.accountId,
          type: 'whatsapp_charge',
          status: 'captured',
          'ref.type': 'whatsapp_message',
          'ref.id': { $in: ids.slice(i, i + 5_000) },
        },
      },
      { $group: { _id: null, micros: { $sum: '$amountMicros' } } },
    ]);
    charged += rows[0]?.micros ?? 0;
  }
  if (charged !== c.cost.chargedMicros) {
    await WhatsAppCampaignModel.updateOne(
      { _id: c._id },
      { $set: { 'cost.chargedMicros': charged } },
    );
  }
  const k = { ...emptyCounters(), ...c.counters };
  return {
    funnel: {
      total: k.total,
      skipped: k.skippedTotal,
      sent: k.sent,
      delivered: k.delivered,
      read: k.read,
      replied: k.replied,
      failed: k.failedTotal,
    },
    cost: { estimateMicros: c.cost.estimateMicros, chargedMicros: charged },
    skippedByReason: k.skipped,
    failedByCode: k.failed,
    perDay: perDay.map((d) => ({ day: d._id, sent: d.sent })),
    variants: variants.map((v) => ({ key: v._id, sent: v.sent, read: v.read, replied: v.replied })),
    winner: c.abWinner?.winner ?? null,
  };
};

/** Messages of the template already sent to these contacts in the window (for the wizard's hint). */
export const recentSendCount = async (
  accountId: Types.ObjectId,
  templateId: Types.ObjectId,
  days: number,
) =>
  MessageModel.countDocuments({
    accountId,
    direction: 'out',
    'template.templateId': templateId,
    createdAt: { $gte: new Date(Date.now() - days * 86_400_000) },
  });
