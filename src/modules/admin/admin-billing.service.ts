import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { adjust, holdForCall, monthKey, releaseHold, settleCall } from '../../core/billing/engine';
import { publishWalletChange, walletStatus } from '../../core/billing/events';
import { holdEstimate } from '../../core/billing/pricing';
import {
  createRateCardVersion,
  effectiveRateCard,
  rateCardById,
  rateCardHistory,
  setAccountToDefault,
  type EffectiveRateCard,
} from '../../core/billing/rates';
import { getOrCreateWallet, setCreditLimit } from '../../core/billing/wallets';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { LedgerEntryModel, type LedgerEntryDoc } from '../../db/models/ledger-entry.model';
import { NotificationModel } from '../../db/models/notification.model';
import {
  PaymentEventModel,
  type PaymentEventDoc,
  type PaymentEventOutcome,
} from '../../db/models/payment-event.model';
import { RateCardModel, type RateCardDoc } from '../../db/models/rate-card.model';
import { TopupOrderModel, type TopupOrderDoc } from '../../db/models/topup-order.model';
import { WalletModel, type WalletDoc } from '../../db/models/wallet.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { formatInr } from '../../shared/money';
import { addDays, startOfDayInZone } from '../../shared/time';
import type { AuditAction } from '../audit/audit-actions';
import { recordAudit } from '../audit/audit.service';
import { notify } from '../notifications/notifications.service';
import { listLedger, toLedgerView, userNames } from '../wallet/ledger.service';
import { toTopupView } from '../wallet/topups.service';
import { accountTimezone, toWalletView } from '../wallet/wallet.service';

import type {
  AdjustmentBody,
  AdminLedgerQuery,
  BackToDefaultBody,
  PaymentEventsQuery,
  PaymentsQuery,
  RateCardBody,
  SimulatedCallBody,
  SimulatedEndBody,
  SummaryQuery,
} from './admin-billing.schema';

/** Platform reports use Indian time (GST months, invoices). */
const PLATFORM_TZ = 'Asia/Kolkata';
/** Spend = what calls cost the customer (adjustments / top-ups are not spend). */
const USAGE_TYPES = ['call_charge', 'ai_charge', 'tts_charge', 'recording_charge', 'subscription'];
/** Webhook outcomes a human should look at. */
const ATTENTION_OUTCOMES: PaymentEventOutcome[] = ['unmatched', 'mismatch', 'refund'];

const VALUE_KEYS = [
  'callPerMinuteMicros',
  'pulseSeconds',
  'aiPerMinuteMicros',
  'ttsPer1kCharsMicros',
  'commissionBps',
  'billUnansweredAttempts',
  'aiTextPer1kTokensMicros',
  'embeddingPer1kTokensMicros',
] as const;

const customerAccount = async (id: string): Promise<AccountDoc> => {
  const _id = toObjectId(id);
  const account = _id ? await AccountModel.findById(_id).lean<AccountDoc>() : null;
  if (!account) throw new NotFoundError('Account not found');
  if (account.isPlatform) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The platform account has no wallet.');
  }
  return account;
};

const actor = (req: Request) => ({
  type: 'user' as const,
  id: requireAuth(req).userId ?? null,
  platform: true,
});

/** Superadmin action audited on the platform account and (if any) the customer account. */
const auditPlatform = async (
  req: Request,
  action: AuditAction,
  target: { type: string; id: string },
  meta: Record<string, unknown>,
  customer?: AccountDoc,
) => {
  const base = { actor: actor(req), action, target, meta, ip: req.ip ?? null };
  if (customer) await recordAudit({ ...base, accountId: customer._id });
  await recordAudit({ ...base, accountId: requireAuth(req).accountId });
};

const versionView = (c: RateCardDoc) => ({
  id: c._id.toString(),
  accountId: c.accountId ? c.accountId.toString() : null,
  ...Object.fromEntries(VALUE_KEYS.map((k) => [k, c[k]])),
  inheritsDefault: c.inheritsDefault,
  effectiveFrom: c.effectiveFrom.toISOString(),
  createdBy: c.createdBy ? c.createdBy.toString() : null,
  note: c.note ?? null,
  createdAt: c.createdAt.toISOString(),
});

const effectiveView = (c: EffectiveRateCard) => ({
  id: c.id,
  source: c.source,
  ...Object.fromEntries(VALUE_KEYS.map((k) => [k, c[k]])),
  effectiveFrom: c.effectiveFrom.toISOString(),
});

/** Field-level diff for the `rate_card.updated` audit. */
const diff = (before: Partial<RateCardDoc> | null, after: Partial<RateCardDoc>) =>
  Object.fromEntries(
    VALUE_KEYS.filter((k) => before?.[k] !== after[k]).map((k) => [
      k,
      { from: before?.[k] ?? null, to: after[k] },
    ]),
  );

const latestDefault = () =>
  RateCardModel.findOne({ accountId: null, effectiveFrom: { $lte: new Date() } })
    .sort({ effectiveFrom: -1, _id: -1 })
    .lean<RateCardDoc>();

// ── Rate cards ────────────────────────────────────────────────────────────

export const getDefaultRateCard = async () => {
  const card = await latestDefault();
  if (!card) throw new NotFoundError('No platform default rate card — run `npm run db:migrate`');
  return versionView(card);
};

export const putDefaultRateCard = async (req: Request, body: z.infer<typeof RateCardBody>) => {
  const before = await latestDefault();
  const { note, ...values } = body;
  const created = await createRateCardVersion({
    accountId: null,
    values,
    createdBy: toObjectId(requireAuth(req).userId ?? '') ?? null,
    note: note ?? null,
  });
  await auditPlatform(
    req,
    'rate_card.updated',
    { type: 'rate_card', id: created._id.toString() },
    { scope: 'default', changes: diff(before, created) },
  );
  return versionView(created);
};

export const defaultRateCardHistory = async (limit: number) =>
  (await rateCardHistory(null, limit)).map(versionView);

const accountCards = async (accountId: Types.ObjectId, limit = 50) => {
  const [effective, history] = await Promise.all([
    effectiveRateCard(accountId, { at: new Date() }),
    rateCardHistory(accountId, limit),
  ]);
  return { effective: effectiveView(effective), history: history.map(versionView) };
};

export const getAccountRateCards = async (id: string, limit: number) =>
  accountCards((await customerAccount(id))._id, limit);

export const createAccountRateCard = async (
  req: Request,
  id: string,
  body: z.infer<typeof RateCardBody>,
) => {
  const account = await customerAccount(id);
  const before = await effectiveRateCard(account._id, { at: new Date() });
  const { note, ...values } = body;
  const created = await createRateCardVersion({
    accountId: account._id,
    values,
    createdBy: toObjectId(requireAuth(req).userId ?? '') ?? null,
    note: note ?? null,
  });
  await auditPlatform(
    req,
    'rate_card.updated',
    { type: 'rate_card', id: created._id.toString() },
    { scope: 'account', changes: diff(before, created) },
    account,
  );
  return accountCards(account._id);
};

export const accountRateCardToDefault = async (
  req: Request,
  id: string,
  body: z.infer<typeof BackToDefaultBody>,
) => {
  const account = await customerAccount(id);
  const before = await effectiveRateCard(account._id, { at: new Date() });
  if (before.source === 'default') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This account already uses the default.');
  }
  const created = await setAccountToDefault({
    accountId: account._id,
    createdBy: toObjectId(requireAuth(req).userId ?? '') ?? null,
    note: body.note ?? null,
  });
  await auditPlatform(
    req,
    'rate_card.updated',
    { type: 'rate_card', id: created._id.toString() },
    { scope: 'account', toDefault: true, changes: diff(before, created) },
    account,
  );
  return accountCards(account._id);
};

// ── Wallet, ledger, credit limit ─────────────────────────────────────────

const walletView = async (accountId: Types.ObjectId, wallet?: WalletDoc) =>
  toWalletView(
    wallet ?? (await getOrCreateWallet(accountId)),
    monthKey(new Date(), await accountTimezone(accountId)),
  );

export const getAccountWallet = async (id: string) => walletView((await customerAccount(id))._id);

export const getAccountLedger = async (id: string, query: z.infer<typeof AdminLedgerQuery>) =>
  listLedger((await customerAccount(id))._id, query);

export const updateCreditLimit = async (req: Request, id: string, creditLimitMicros: number) => {
  const account = await customerAccount(id);
  const { before, after } = await setCreditLimit(account._id, creditLimitMicros);
  if (before.creditLimitMicros !== after.creditLimitMicros) {
    const snap = (w: WalletDoc) => ({
      balanceMicros: w.balanceMicros,
      holdMicros: w.holdMicros,
      creditLimitMicros: w.creditLimitMicros,
      lowBalanceThresholdMicros: w.lowBalanceThresholdMicros,
    });
    await publishWalletChange({
      accountId: account._id.toString(),
      before: snap(before),
      after: snap(after),
    });
    await auditPlatform(
      req,
      'wallet.credit_limit_updated',
      { type: 'wallet', id: after._id.toString() },
      { from: before.creditLimitMicros, to: after.creditLimitMicros },
      account,
    );
  }
  return walletView(account._id, after);
};

export const createAdjustment = async (
  req: Request,
  id: string,
  key: string,
  body: z.infer<typeof AdjustmentBody>,
) => {
  const account = await customerAccount(id);
  const auth = requireAuth(req);
  const result = await adjust({
    accountId: account._id,
    direction: body.direction,
    amountMicros: body.amountMicros,
    reason: body.reason,
    createdBy: auth.userId ?? '',
    // the HTTP key is scoped per target account by the idempotency middleware too
    idempotencyKey: `adjust:${account._id.toString()}:${key}`,
    allowNegative: body.allowNegative ?? false,
  });
  const entry = result.entries[0];
  if (!entry) throw new Error('adjustment produced no ledger row');
  if (!result.replay) {
    await auditPlatform(
      req,
      'wallet.adjusted',
      { type: 'account', id: account._id.toString() },
      { direction: body.direction, amountMicros: body.amountMicros, reason: body.reason },
      account,
    );
    const sign = body.direction === 'credit' ? 'added to' : 'deducted from';
    await notify({
      accountId: account._id,
      permission: 'wallet.read',
      type: 'wallet.adjusted',
      title: 'Wallet adjusted by support',
      body: `${formatInr(body.amountMicros)} was ${sign} your wallet. Reason: ${body.reason}`,
      link: '/wallet?tab=transactions',
    });
  }
  return {
    entry: toLedgerView(entry, await userNames([entry])),
    wallet: await walletView(account._id, result.wallet),
  };
};

// ── Simulator ────────────────────────────────────────────────────────────

export const startSimulatedCall = async (id: string, body: z.infer<typeof SimulatedCallBody>) => {
  const account = await customerAccount(id);
  const card = await effectiveRateCard(account._id, { at: new Date() });
  const simId = new Types.ObjectId().toString();
  const result = await holdForCall({
    accountId: account._id,
    ref: { type: 'simulator', id: simId },
    idempotencyKey: `sim:${simId}`,
    estimateMicros: holdEstimate(card, body.estimateMinutes),
  });
  const hold = result.entries[0];
  if (!hold) throw new Error('hold produced no ledger row');
  return {
    holdId: hold._id.toString(),
    heldMicros: hold.amountMicros,
    rateCard: effectiveView(card),
    wallet: await walletView(account._id, result.wallet),
  };
};

export const endSimulatedCall = async (
  id: string,
  holdId: string,
  body: z.infer<typeof SimulatedEndBody>,
) => {
  const account = await customerAccount(id);
  const root = await LedgerEntryModel.findOne({
    _id: new Types.ObjectId(holdId),
    accountId: account._id,
    holdId: null,
    'ref.type': 'simulator',
  }).lean<LedgerEntryDoc>();
  if (!root) throw new NotFoundError('Simulated call not found');
  const card = root.rateCardId
    ? await rateCardById(root.rateCardId)
    : await effectiveRateCard(account._id);
  const billable = body.answered || card.billUnansweredAttempts;
  const result = billable
    ? await settleCall({ accountId: account._id, holdId: root._id, usage: body })
    : await releaseHold({ accountId: account._id, holdId: root._id, reason: 'unanswered' });
  const rows = await LedgerEntryModel.find({
    accountId: account._id,
    $or: [{ _id: root._id }, { holdId: root._id }],
  })
    .sort({ createdAt: 1, _id: 1 })
    .lean<LedgerEntryDoc[]>();
  const names = await userNames(rows);
  return {
    outcome: billable ? ('charged' as const) : ('released' as const),
    entries: rows.map((r) => toLedgerView(r, names)),
    wallet: await walletView(account._id, result.wallet),
  };
};

// ── Platform summary, payments, payment events ───────────────────────────

const monthRange = (month: string) => {
  const [y = 0, m = 1] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return {
    from: startOfDayInZone(`${month}-01`, PLATFORM_TZ),
    to: startOfDayInZone(`${next}-01`, PLATFORM_TZ),
  };
};

const sumOf = (field: string) => ({ $sum: `$${field}` });

export const billingSummary = async (req: Request, query: z.infer<typeof SummaryQuery>) => {
  const month = query.month ?? monthKey(new Date(), PLATFORM_TZ);
  const { from, to } = monthRange(month);
  const inMonth = { $gte: from, $lt: to };
  const auth = requireAuth(req);

  const [topups] = await TopupOrderModel.aggregate<Record<string, number>>([
    { $match: { status: 'paid', paidAt: inMonth } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        baseMicros: sumOf('baseMicros'),
        cgstMicros: sumOf('cgstMicros'),
        sgstMicros: sumOf('sgstMicros'),
        igstMicros: sumOf('igstMicros'),
        taxMicros: sumOf('taxMicros'),
        totalMicros: sumOf('totalMicros'),
      },
    },
  ]);
  const usageMatch = {
    status: 'captured',
    direction: 'debit',
    type: { $in: USAGE_TYPES },
    createdAt: inMonth,
  };
  const byType = await LedgerEntryModel.aggregate<{ _id: string; amountMicros: number }>([
    { $match: usageMatch },
    { $group: { _id: '$type', amountMicros: sumOf('amountMicros') } },
    { $sort: { _id: 1 } },
  ]);
  const aiKinds = await LedgerEntryModel.aggregate<{
    _id: string | null;
    count: number;
    inputTokens: number;
    outputTokens: number;
    embeddingTokens: number;
  }>([
    { $match: { ...usageMatch, type: 'ai_charge', 'breakdown.kind': { $exists: true } } },
    {
      $group: {
        _id: '$breakdown.kind',
        count: { $sum: 1 },
        inputTokens: sumOf('breakdown.inputTokens'),
        outputTokens: sumOf('breakdown.outputTokens'),
        embeddingTokens: sumOf('breakdown.embeddingTokens'),
      },
    },
  ]);
  const aiSum = (k: 'inputTokens' | 'outputTokens' | 'embeddingTokens') =>
    aiKinds.reduce((s, row) => s + row[k], 0);
  const adjustments = await LedgerEntryModel.aggregate<{ _id: string; amountMicros: number }>([
    { $match: { type: 'adjustment', status: 'captured', createdAt: inMonth } },
    { $group: { _id: '$direction', amountMicros: sumOf('amountMicros') } },
  ]);
  const top = await LedgerEntryModel.aggregate<{ _id: Types.ObjectId; spendMicros: number }>([
    { $match: usageMatch },
    { $group: { _id: '$accountId', spendMicros: sumOf('amountMicros') } },
    { $sort: { spendMicros: -1, _id: 1 } },
    { $limit: 10 },
  ]);
  const names = new Map(
    (
      await AccountModel.find({ _id: { $in: top.map((t) => t._id) } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    ).map((a) => [a._id.toString(), a.name]),
  );

  const wallets = { total: 0, low: 0, exhausted: 0 };
  const cursor = WalletModel.find()
    .select({ balanceMicros: 1, holdMicros: 1, creditLimitMicros: 1, lowBalanceThresholdMicros: 1 })
    .lean<WalletDoc[]>()
    .cursor();
  for await (const w of cursor) {
    wallets.total += 1;
    const status = walletStatus(w);
    if (status !== 'ok') wallets[status] += 1;
  }

  const [openReconcileMismatches, paymentEventsNeedingAttention] = await Promise.all([
    NotificationModel.countDocuments({
      accountId: auth.accountId,
      userId: auth.userId,
      type: 'billing.reconcile_mismatch',
      readAt: null,
    }),
    PaymentEventModel.countDocuments({
      outcome: { $in: ATTENTION_OUTCOMES },
      receivedAt: inMonth,
    }),
  ]);

  const money = (k: string) => topups?.[k] ?? 0;
  return {
    month,
    from: from.toISOString(),
    to: to.toISOString(),
    topups: {
      count: money('count'),
      baseMicros: money('baseMicros'),
      cgstMicros: money('cgstMicros'),
      sgstMicros: money('sgstMicros'),
      igstMicros: money('igstMicros'),
      taxMicros: money('taxMicros'),
      totalMicros: money('totalMicros'),
    },
    usage: {
      byType: byType.map((u) => ({ type: u._id, amountMicros: u.amountMicros })),
      totalMicros: byType.reduce((s, u) => s + u.amountMicros, 0),
    },
    ai: {
      playgroundTurns: aiKinds.find((r) => r._id === 'playground')?.count ?? 0,
      kbIngests: aiKinds.find((r) => r._id === 'kb_ingest')?.count ?? 0,
      inputTokens: aiSum('inputTokens'),
      outputTokens: aiSum('outputTokens'),
      embeddingTokens: aiSum('embeddingTokens'),
    },
    adjustments: {
      creditMicros: adjustments.find((a) => a._id === 'credit')?.amountMicros ?? 0,
      debitMicros: adjustments.find((a) => a._id === 'debit')?.amountMicros ?? 0,
    },
    topAccounts: top.map((t) => ({
      accountId: t._id.toString(),
      name: names.get(t._id.toString()) ?? '(deleted account)',
      spendMicros: t.spendMicros,
    })),
    wallets,
    openReconcileMismatches,
    paymentEventsNeedingAttention,
  };
};

const pageMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});

export const listPayments = async (query: z.infer<typeof PaymentsQuery>) => {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;
  if (query.account) filter.accountId = new Types.ObjectId(query.account);
  const at: Record<string, Date> = {};
  if (query.from) at.$gte = startOfDayInZone(query.from, PLATFORM_TZ);
  if (query.to) at.$lt = startOfDayInZone(addDays(query.to, 1), PLATFORM_TZ);
  if (Object.keys(at).length) filter.createdAt = at;
  const [rows, total] = await Promise.all([
    TopupOrderModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<TopupOrderDoc[]>(),
    TopupOrderModel.countDocuments(filter),
  ]);
  const names = new Map(
    (
      await AccountModel.find({ _id: { $in: [...new Set(rows.map((r) => r.accountId))] } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    ).map((a) => [a._id.toString(), a.name]),
  );
  return {
    items: rows.map((r) => ({
      ...toTopupView(r),
      accountId: r.accountId.toString(),
      accountName: names.get(r.accountId.toString()) ?? null,
      providerPaymentId: r.providerPaymentId ?? null,
    })),
    meta: pageMeta(query.page, query.limit, total),
  };
};

const eventView = (e: PaymentEventDoc) => ({
  id: e._id.toString(),
  provider: e.provider,
  eventId: e.eventId,
  type: e.type,
  accountId: e.accountId ? e.accountId.toString() : null,
  topupOrderId: e.topupOrderId ? e.topupOrderId.toString() : null,
  providerOrderId: e.providerOrderId ?? null,
  providerPaymentId: e.providerPaymentId ?? null,
  outcome: e.outcome,
  receivedAt: e.receivedAt.toISOString(),
  processedAt: e.processedAt ? e.processedAt.toISOString() : null,
});

export const listPaymentEvents = async (query: z.infer<typeof PaymentEventsQuery>) => {
  const filter = query.outcome ? { outcome: query.outcome } : {};
  const [rows, total] = await Promise.all([
    PaymentEventModel.find(filter)
      .sort({ receivedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<PaymentEventDoc[]>(),
    PaymentEventModel.countDocuments(filter),
  ]);
  return { items: rows.map(eventView), meta: pageMeta(query.page, query.limit, total) };
};
