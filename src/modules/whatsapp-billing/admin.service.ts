import type { Request } from 'express';
import { Types } from 'mongoose';

import { diffRateCards, parseMetaRateCsv } from '../../core/billing/whatsapp';
import {
  AccountModel,
  DEFAULT_ACCOUNT_WHATSAPP,
  type AccountWhatsAppBilling,
} from '../../db/models/account.model';
import { MessageModel } from '../../db/models/message.model';
import {
  DEFAULT_WHATSAPP_BILLING_SETTINGS,
  PlatformSettingsModel,
  type WhatsAppBillingSettings,
} from '../../db/models/platform-settings.model';
import { WhatsAppBillingDailyModel } from '../../db/models/whatsapp-billing-daily.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import {
  MESSAGING_CARDS,
  rateCardProblems,
  WhatsAppRateCardModel,
  type RateCardMarket,
  type RateCardSource,
  type WhatsAppRateCardDoc,
} from '../../db/models/whatsapp-rate-card.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';

import {
  effectiveWhatsAppRateCard,
  invalidateWhatsAppPricingCache,
  whatsAppBillingSettings,
} from './pricing.service';

/** Superadmin audit on the platform account (and the customer account when given). */
const auditPlatform = async (
  req: Request,
  action: AuditAction,
  meta: Record<string, unknown>,
  target: { type: string; id: string },
  accountId?: Types.ObjectId,
) => {
  const auth = requireAuth(req);
  const base = {
    actor: { type: 'user' as const, id: auth.userId ?? null, platform: true },
    action,
    target,
    meta,
    ip: req.ip ?? null,
  };
  await recordAudit({ ...base, accountId: auth.accountId });
  if (accountId) await recordAudit({ ...base, accountId });
};

const cardView = (c: WhatsAppRateCardDoc) => ({
  id: c._id.toString(),
  effectiveFrom: c.effectiveFrom.toISOString(),
  currency: c.currency,
  source: c.source,
  note: c.note,
  createdAt: c.createdAt.toISOString(),
  markets: c.markets,
});

/* ── rate cards ──────────────────────────────────────────────────────────── */

export const listRateCards = async () => {
  const cards = await WhatsAppRateCardModel.find(MESSAGING_CARDS)
    .sort({ effectiveFrom: -1, _id: -1 })
    .limit(50)
    .lean<WhatsAppRateCardDoc[]>();
  const now = Date.now();
  const current = cards.find((c) => c.effectiveFrom.getTime() <= now) ?? null;
  return {
    current: current ? cardView(current) : null,
    scheduled: cards.filter((c) => c.effectiveFrom.getTime() > now).map(cardView),
    history: cards.map((c) => ({
      id: c._id.toString(),
      effectiveFrom: c.effectiveFrom.toISOString(),
      source: c.source,
      note: c.note,
      markets: c.markets.length,
    })),
  };
};

/** CSV upload → parsed markets + what changes against the card in force (nothing saved). */
export const previewRateCardImport = async (bytes: Buffer) => {
  const parsed = parseMetaRateCsv(bytes);
  const current = await effectiveWhatsAppRateCard();
  return {
    markets: parsed.markets,
    errors: parsed.errors,
    diff: parsed.errors.length ? null : diffRateCards(current.markets, parsed.markets),
  };
};

export const saveRateCard = async (
  req: Request,
  input: {
    markets: RateCardMarket[];
    effectiveFrom?: Date;
    source: RateCardSource;
    note?: string | null;
  },
) => {
  const effectiveFrom = input.effectiveFrom ?? new Date();
  if (effectiveFrom.getTime() < Date.now() - 60_000) {
    throw new ValidationError([{ path: 'effectiveFrom', message: 'Must be now or later' }]);
  }
  const problems = rateCardProblems(input.markets);
  if (problems.length) {
    throw new ValidationError(problems.map((message) => ({ path: 'markets', message })));
  }
  const auth = requireAuth(req);
  const doc = await WhatsAppRateCardModel.create({
    effectiveFrom,
    source: input.source,
    note: input.note ?? null,
    createdBy: auth.userId ? new Types.ObjectId(auth.userId) : null,
    markets: input.markets,
  });
  invalidateWhatsAppPricingCache();
  await auditPlatform(
    req,
    'whatsapp.rate_card_saved',
    {
      source: input.source,
      markets: input.markets.length,
      effectiveFrom: effectiveFrom.toISOString(),
    },
    { type: 'whatsapp_rate_card', id: doc._id.toString() },
  );
  return cardView(doc.toObject({ transform: false }));
};

/* ── global settings ─────────────────────────────────────────────────────── */

/** Settings + platform-payer numbers still billed in another currency (INR deadline 31 Dec 2026). */
export const getBillingSettings = async () => {
  const settings = await whatsAppBillingSettings();
  const nonInr = await WhatsAppChannelModel.find({
    metaPayer: 'platform',
    status: { $ne: 'disconnected' },
    wabaCurrency: { $nin: [null, 'INR'] },
  })
    .select({ accountId: 1, label: 1, wabaCurrency: 1 })
    .lean<
      { _id: Types.ObjectId; accountId: Types.ObjectId; label: string; wabaCurrency: string }[]
    >();
  return {
    settings,
    defaults: DEFAULT_WHATSAPP_BILLING_SETTINGS,
    nonInrPlatformChannels: nonInr.map((c) => ({
      channelId: c._id.toString(),
      accountId: c.accountId.toString(),
      label: c.label,
      wabaCurrency: c.wabaCurrency,
    })),
  };
};

export const updateBillingSettings = async (
  req: Request,
  patch: Partial<WhatsAppBillingSettings>,
) => {
  const before = await whatsAppBillingSettings();
  const value = { ...before, ...patch };
  const auth = requireAuth(req);
  await PlatformSettingsModel.updateOne(
    { key: 'whatsappBilling' },
    { $set: { value, updatedBy: auth.userId ? new Types.ObjectId(auth.userId) : null } },
    { upsert: true, runValidators: true },
  );
  invalidateWhatsAppPricingCache();
  const fields = (Object.keys(patch) as (keyof WhatsAppBillingSettings)[]).filter(
    (k) => before[k] !== value[k],
  );
  if (fields.length) {
    await auditPlatform(
      req,
      'whatsapp.billing_settings_updated',
      { fields },
      {
        type: 'platform_settings',
        id: 'whatsappBilling',
      },
    );
  }
  return getBillingSettings();
};

/* ── account override (extends the Phase 9 billing-mode route) ──────────── */

export interface AccountBillingPatch {
  metaPayer?: 'platform' | 'customer';
  markupBps?: number | null;
  fixedPrices?: AccountWhatsAppBilling['fixedPrices'];
  platformFeeMicros?: number | null;
}

export const updateAccountWhatsAppBilling = async (
  req: Request,
  accountId: string,
  patch: AccountBillingPatch,
) => {
  if (!Types.ObjectId.isValid(accountId)) throw new NotFoundError('Account not found');
  const account = await AccountModel.findOne({ _id: accountId })
    .select({ whatsapp: 1, whatsappBilling: 1, isPlatform: 1 })
    .lean<{
      _id: Types.ObjectId;
      whatsapp?: { metaPayer?: 'platform' | 'customer' };
      whatsappBilling?: AccountWhatsAppBilling | null;
      isPlatform?: boolean;
    }>();
  if (!account) throw new NotFoundError('Account not found');
  if (account.isPlatform) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'The platform account cannot be managed here.',
    );
  }
  const metaPayer = account.whatsapp?.metaPayer ?? DEFAULT_ACCOUNT_WHATSAPP.metaPayer;
  const before: AccountWhatsAppBilling = account.whatsappBilling ?? {
    markupBps: null,
    fixedPrices: null,
    platformFeeMicros: null,
  };
  const next: AccountWhatsAppBilling = {
    markupBps: patch.markupBps === undefined ? before.markupBps : patch.markupBps,
    fixedPrices: patch.fixedPrices === undefined ? before.fixedPrices : patch.fixedPrices,
    platformFeeMicros:
      patch.platformFeeMicros === undefined ? before.platformFeeMicros : patch.platformFeeMicros,
  };
  const set: Record<string, unknown> = { whatsappBilling: next };
  if (patch.metaPayer) set['whatsapp.metaPayer'] = patch.metaPayer;
  await AccountModel.updateOne({ _id: account._id }, { $set: set }, { runValidators: true });
  const target = { type: 'account', id: account._id.toString() };
  if (patch.metaPayer && patch.metaPayer !== metaPayer) {
    await auditPlatform(
      req,
      'whatsapp.billing_mode_changed',
      { from: metaPayer, to: patch.metaPayer },
      target,
      account._id,
    );
  }
  const fields = (['markupBps', 'fixedPrices', 'platformFeeMicros'] as const).filter(
    (k) => patch[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(next[k]),
  );
  if (fields.length) {
    await auditPlatform(req, 'account.whatsapp_billing_updated', { fields }, target, account._id);
  }
  return { metaPayer: patch.metaPayer ?? metaPayer, whatsappBilling: next };
};

/* ── reports ─────────────────────────────────────────────────────────────── */

const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
};

export interface MarginRow {
  accountId: string;
  accountName: string;
  category: string;
  messages: number;
  billedMicros: number;
  metaCostMicros: number;
  /** `analytics` = Meta's pricing analytics for the month; `list` = our rate card cost. */
  metaCostSource: 'analytics' | 'list';
  marginMicros: number;
  marginBps: number | null;
  mismatches: number;
}

/** Per account × category for a UTC month: charges captured vs what Meta charges us. */
export const marginReport = async (month: string, accountId?: string): Promise<MarginRow[]> => {
  const { start, end } = monthRange(month);
  const match: Record<string, unknown> = {
    'billing.status': { $in: ['captured', 'late_charged'] },
    'billing.payer': 'platform',
    'billing.at': { $gte: start, $lt: end },
  };
  if (accountId && Types.ObjectId.isValid(accountId))
    match.accountId = new Types.ObjectId(accountId);
  const ours = await MessageModel.aggregate<{
    _id: { accountId: Types.ObjectId; category: string };
    messages: number;
    billed: number;
    listCost: number;
    mismatches: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: { accountId: '$accountId', category: '$billing.category' },
        messages: { $sum: 1 },
        billed: { $sum: '$billing.priceMicros' },
        listCost: { $sum: '$billing.metaCostMicros' },
        mismatches: { $sum: { $cond: ['$billing.categoryMismatch', 1, 0] } },
      },
    },
  ]);
  const analytics = await WhatsAppBillingDailyModel.aggregate<{
    _id: { accountId: Types.ObjectId; category: string };
    cost: number;
  }>([
    {
      $match: {
        day: { $gte: start.toISOString().slice(0, 10), $lt: end.toISOString().slice(0, 10) },
        ...(match.accountId ? { accountId: match.accountId } : {}),
      },
    },
    {
      $group: {
        _id: { accountId: '$accountId', category: '$category' },
        cost: { $sum: '$metaCostMicros' },
      },
    },
  ]);
  const metaCost = new Map(
    analytics.map((a) => [`${a._id.accountId.toString()}|${a._id.category}`, a.cost]),
  );
  const names = new Map(
    (
      await AccountModel.find({ _id: { $in: ours.map((o) => o._id.accountId) } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    ).map((a) => [a._id.toString(), a.name]),
  );
  return ours
    .map((o) => {
      const key = `${o._id.accountId.toString()}|${o._id.category}`;
      const fromAnalytics = metaCost.get(key);
      const cost = fromAnalytics ?? o.listCost;
      const margin = o.billed - cost;
      return {
        accountId: o._id.accountId.toString(),
        accountName: names.get(o._id.accountId.toString()) ?? '',
        category: o._id.category,
        messages: o.messages,
        billedMicros: o.billed,
        metaCostMicros: cost,
        metaCostSource: fromAnalytics === undefined ? ('list' as const) : ('analytics' as const),
        marginMicros: margin,
        marginBps: o.billed > 0 ? Math.round((margin * 10_000) / o.billed) : null,
        mismatches: o.mismatches,
      };
    })
    .sort(
      (a, b) => a.accountName.localeCompare(b.accountName) || a.category.localeCompare(b.category),
    );
};

export const reconciliationReport = async (month: string) => {
  const { start, end } = monthRange(month);
  const rows = await WhatsAppBillingDailyModel.find({
    day: { $gte: start.toISOString().slice(0, 10), $lt: end.toISOString().slice(0, 10) },
  })
    .sort({ day: -1, wabaId: 1, category: 1 })
    .limit(5000)
    .lean();
  return rows.map((r) => ({
    accountId: r.accountId.toString(),
    wabaId: r.wabaId,
    day: r.day,
    category: r.category,
    metaVolume: r.metaVolume,
    metaCostMicros: r.metaCostMicros,
    ourCaptured: r.ourCaptured,
    ourBilledMicros: r.ourBilledMicros,
    diffVolume: r.diffVolume,
    diffMicros: r.diffMicros,
    fetchedAt: r.fetchedAt.toISOString(),
  }));
};
