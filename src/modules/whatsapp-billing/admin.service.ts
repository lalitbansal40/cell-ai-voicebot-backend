import type { Request } from 'express';
import { Types } from 'mongoose';

import { diffRateCards, parseMetaRateCsv } from '../../core/billing/whatsapp';
import { diffCallingCards, parseCallingRateCsv } from '../../core/billing/whatsapp-calls';
import {
  AccountModel,
  DEFAULT_ACCOUNT_WHATSAPP,
  DEFAULT_ACCOUNT_WHATSAPP_CALLING_BILLING,
  type AccountWhatsAppBilling,
  type AccountWhatsAppCallingBilling,
} from '../../db/models/account.model';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { MessageModel } from '../../db/models/message.model';
import {
  DEFAULT_WHATSAPP_BILLING_SETTINGS,
  DEFAULT_WHATSAPP_CALLING_SETTINGS,
  PlatformSettingsModel,
  type WhatsAppBillingSettings,
  type WhatsAppCallingSettings,
} from '../../db/models/platform-settings.model';
import { WhatsAppBillingDailyModel } from '../../db/models/whatsapp-billing-daily.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import {
  MESSAGING_CARDS,
  rateCardProblems,
  WhatsAppRateCardModel,
  type CallingRateMarket,
  type RateCardMarket,
  type RateCardSource,
  type WhatsAppRateCardDoc,
} from '../../db/models/whatsapp-rate-card.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { effectiveCallingCard, whatsAppCallingSettings } from '../whatsapp-calling/billing';

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

/* ── calling rate cards (Phase 12) ───────────────────────────────────────── */

const callingCardView = (c: WhatsAppRateCardDoc) => ({
  id: c._id.toString(),
  kind: 'calling' as const,
  effectiveFrom: c.effectiveFrom.toISOString(),
  currency: c.currency,
  source: c.source,
  note: c.note,
  createdAt: c.createdAt.toISOString(),
  callingMarkets: c.callingMarkets,
});

export const listCallingRateCards = async () => {
  const cards = await WhatsAppRateCardModel.find({ kind: 'calling' })
    .sort({ effectiveFrom: -1, _id: -1 })
    .limit(50)
    .lean<WhatsAppRateCardDoc[]>();
  const now = Date.now();
  const current = cards.find((c) => c.effectiveFrom.getTime() <= now) ?? null;
  return {
    current: current ? callingCardView(current) : null,
    scheduled: cards.filter((c) => c.effectiveFrom.getTime() > now).map(callingCardView),
    history: cards.map((c) => ({
      id: c._id.toString(),
      effectiveFrom: c.effectiveFrom.toISOString(),
      source: c.source,
      note: c.note,
      markets: c.callingMarkets.length,
    })),
  };
};

/** Calling CSV → markets + changes against the calling card in force (nothing saved). */
export const previewCallingRateCardImport = async (bytes: Buffer) => {
  const parsed = parseCallingRateCsv(bytes);
  const current = await effectiveCallingCard();
  return {
    callingMarkets: parsed.markets,
    errors: parsed.errors,
    diff: parsed.errors.length ? null : diffCallingCards(current.markets, parsed.markets),
  };
};

export const saveCallingRateCard = async (
  req: Request,
  input: {
    callingMarkets: CallingRateMarket[];
    effectiveFrom?: Date;
    source: RateCardSource;
    note?: string | null;
  },
) => {
  const effectiveFrom = input.effectiveFrom ?? new Date();
  if (effectiveFrom.getTime() < Date.now() - 60_000) {
    throw new ValidationError([{ path: 'effectiveFrom', message: 'Must be now or later' }]);
  }
  const problems = rateCardProblems(input.callingMarkets);
  if (problems.length) {
    throw new ValidationError(problems.map((message) => ({ path: 'callingMarkets', message })));
  }
  const auth = requireAuth(req);
  const doc = await WhatsAppRateCardModel.create({
    kind: 'calling',
    effectiveFrom,
    source: input.source,
    note: input.note ?? null,
    createdBy: auth.userId ? new Types.ObjectId(auth.userId) : null,
    markets: [],
    callingMarkets: input.callingMarkets,
  });
  await auditPlatform(
    req,
    'whatsapp.rate_card_saved',
    {
      kind: 'calling',
      source: input.source,
      markets: input.callingMarkets.length,
      effectiveFrom: effectiveFrom.toISOString(),
    },
    { type: 'whatsapp_rate_card', id: doc._id.toString() },
  );
  return callingCardView(doc.toObject({ transform: false }));
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
    calling: await whatsAppCallingSettings(),
    callingDefaults: DEFAULT_WHATSAPP_CALLING_SETTINGS,
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
  input: Partial<WhatsAppBillingSettings> & { calling?: Partial<WhatsAppCallingSettings> },
) => {
  const { calling, ...patch } = input;
  const before = await whatsAppBillingSettings();
  const value = { ...before, ...patch };
  const auth = requireAuth(req);
  const updatedBy = auth.userId ? new Types.ObjectId(auth.userId) : null;
  await PlatformSettingsModel.updateOne(
    { key: 'whatsappBilling' },
    { $set: { value, updatedBy } },
    { upsert: true, runValidators: true },
  );
  invalidateWhatsAppPricingCache();
  const fields: string[] = (Object.keys(patch) as (keyof WhatsAppBillingSettings)[]).filter(
    (k) => before[k] !== value[k],
  );
  if (calling) {
    // Phase 12: call markup / fee / hold minutes (read at every dial, no cache)
    const was = await whatsAppCallingSettings();
    const next = { ...was, ...calling };
    await PlatformSettingsModel.updateOne(
      { key: 'whatsappCalling' },
      { $set: { value: next, updatedBy } },
      { upsert: true, runValidators: true },
    );
    for (const k of Object.keys(calling) as (keyof WhatsAppCallingSettings)[]) {
      if (was[k] !== next[k]) fields.push(`calling.${k}`);
    }
  }
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
  /** Phase 12: the call price override (null = platform defaults). */
  calling?: Partial<AccountWhatsAppCallingBilling> | null;
}

export const updateAccountWhatsAppBilling = async (
  req: Request,
  accountId: string,
  patch: AccountBillingPatch,
) => {
  if (!Types.ObjectId.isValid(accountId)) throw new NotFoundError('Account not found');
  const account = await AccountModel.findOne({ _id: accountId })
    .select({ whatsapp: 1, whatsappBilling: 1, whatsappCallingBilling: 1, isPlatform: 1 })
    .lean<{
      _id: Types.ObjectId;
      whatsapp?: { metaPayer?: 'platform' | 'customer' };
      whatsappBilling?: AccountWhatsAppBilling | null;
      whatsappCallingBilling?: AccountWhatsAppCallingBilling | null;
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
  const callingBefore = account.whatsappCallingBilling ?? DEFAULT_ACCOUNT_WHATSAPP_CALLING_BILLING;
  const callingNext: AccountWhatsAppCallingBilling =
    patch.calling === undefined
      ? callingBefore
      : patch.calling === null
        ? DEFAULT_ACCOUNT_WHATSAPP_CALLING_BILLING
        : { ...callingBefore, ...patch.calling };
  const set: Record<string, unknown> = {
    whatsappBilling: next,
    whatsappCallingBilling: callingNext,
  };
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
  const fields: string[] = (['markupBps', 'fixedPrices', 'platformFeeMicros'] as const).filter(
    (k) => patch[k] !== undefined && JSON.stringify(before[k]) !== JSON.stringify(next[k]),
  );
  if (JSON.stringify(callingBefore) !== JSON.stringify(callingNext)) fields.push('calling');
  if (fields.length) {
    await auditPlatform(req, 'account.whatsapp_billing_updated', { fields }, target, account._id);
  }
  return {
    metaPayer: patch.metaPayer ?? metaPayer,
    whatsappBilling: next,
    whatsappCallingBilling: callingNext,
  };
};

/* ── reports ─────────────────────────────────────────────────────────────── */

const monthRange = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
};

export interface MarginRow {
  accountId: string;
  accountName: string;
  /** `message` rows per category (Phase 11); `call` rows: WhatsApp calls (category `call`). */
  kind: 'message' | 'call';
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
    .map((o): MarginRow => {
      const key = `${o._id.accountId.toString()}|${o._id.category}`;
      const fromAnalytics = metaCost.get(key);
      const cost = fromAnalytics ?? o.listCost;
      const margin = o.billed - cost;
      return {
        accountId: o._id.accountId.toString(),
        accountName: names.get(o._id.accountId.toString()) ?? '',
        kind: 'message' as const,
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
    .concat(await callMarginRows(start, end, match.accountId as Types.ObjectId | undefined))
    .sort(
      (a, b) =>
        a.accountName.localeCompare(b.accountName) ||
        a.kind.localeCompare(b.kind) ||
        a.category.localeCompare(b.category),
    );
};

/**
 * Settled WhatsApp call charges of the month per account (Phase 12): billed vs Meta's
 * list cost (pulses × base-tier rate); a lower volume tier at Meta is our margin.
 * `mismatches` = calls settled on our measured time (Meta's duration came late).
 */
const callMarginRows = async (
  start: Date,
  end: Date,
  accountId?: Types.ObjectId,
): Promise<MarginRow[]> => {
  const rows = await LedgerEntryModel.aggregate<{
    _id: Types.ObjectId;
    calls: number;
    billed: number;
    cost: number;
    ours: number;
  }>([
    {
      $match: {
        type: 'whatsapp_call_charge',
        status: 'captured',
        createdAt: { $gte: start, $lt: end },
        ...(accountId ? { accountId } : {}),
      },
    },
    {
      $group: {
        _id: '$accountId',
        calls: { $sum: 1 },
        billed: { $sum: '$amountMicros' },
        cost: { $sum: { $ifNull: ['$breakdown.metaCostMicros', 0] } },
        ours: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$note', null] }, null] }, 1, 0] } },
      },
    },
  ]);
  if (!rows.length) return [];
  const names = new Map(
    (
      await AccountModel.find({ _id: { $in: rows.map((r) => r._id) } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    ).map((a) => [a._id.toString(), a.name]),
  );
  return rows.map((r) => {
    const margin = r.billed - r.cost;
    return {
      accountId: r._id.toString(),
      accountName: names.get(r._id.toString()) ?? '',
      kind: 'call' as const,
      category: 'call',
      messages: r.calls,
      billedMicros: r.billed,
      metaCostMicros: r.cost,
      metaCostSource: 'list' as const,
      marginMicros: margin,
      marginBps: r.billed > 0 ? Math.round((margin * 10_000) / r.billed) : null,
      mismatches: r.ours,
    };
  });
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
