import { Types, type ClientSession, type PipelineStage } from 'mongoose';

import { BILLING_LIMITS } from '../../config/limits';
import { isDuplicateKeyError } from '../../db/errors';
import { AccountModel } from '../../db/models/account.model';
import {
  LedgerEntryModel,
  type LedgerBreakdown,
  type LedgerEntryDoc,
  type LedgerRefType,
  type LedgerType,
} from '../../db/models/ledger-entry.model';
import { WalletModel, type WalletDoc } from '../../db/models/wallet.model';
import { withTransaction } from '../../db/transaction';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { assertMicros } from '../../shared/money';

import {
  availableMicros,
  publishWalletChange,
  type WalletChange,
  type WalletSnapshot,
} from './events';
import { callCharge, holdEstimate, spendShares, type CallUsage } from './pricing';
import { effectiveRateCard, rateCardById } from './rates';
import { getOrCreateWallet } from './wallets';

/**
 * The ONLY code that changes wallets and ledger rows (PHASE_4_PLAN §1b / ADR 0032):
 * one conditional `findOneAndUpdate` (balance check + change in a single
 * query) and the ledger insert in the same transaction, an idempotency key
 * per operation, side effects (WS, alerts) only after commit.
 */

export interface LedgerRef {
  type: LedgerRefType;
  id: string;
}

export interface EngineResult {
  entries: LedgerEntryDoc[];
  wallet: WalletDoc;
  /** `true` when the idempotency key was already used — nothing changed. */
  replay: boolean;
  /**
   * Only when run inside the caller's session: the change to publish with
   * `publishWalletChange` AFTER the caller's transaction commits.
   */
  change?: WalletChange | null;
}

interface TxOutput {
  result: EngineResult;
  change: WalletChange | null;
}

const snapshot = (w: WalletDoc): WalletSnapshot => ({
  balanceMicros: w.balanceMicros,
  holdMicros: w.holdMicros,
  creditLimitMicros: w.creditLimitMicros,
  lowBalanceThresholdMicros: w.lowBalanceThresholdMicros,
});

const change = (
  accountId: Types.ObjectId,
  after: WalletDoc,
  dBalance: number,
  dHold: number,
): WalletChange => {
  const a = snapshot(after);
  return {
    accountId: accountId.toString(),
    after: a,
    before: { ...a, balanceMicros: a.balanceMicros - dBalance, holdMicros: a.holdMicros - dHold },
  };
};

const oid = (id: Types.ObjectId | string): Types.ObjectId =>
  typeof id === 'string' ? new Types.ObjectId(id) : id;

/** `YYYY-MM` of `date` in `timeZone`. */
export const monthKey = (date: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year ?? '0000'}-${parts.month ?? '00'}`;
};

const accountMonth = async (accountId: Types.ObjectId, session: ClientSession): Promise<string> => {
  const account = await AccountModel.findById(accountId)
    .select({ timezone: 1 })
    .session(session)
    .lean<{ timezone?: string }>();
  return monthKey(new Date(), account?.timezone ?? 'Asia/Kolkata');
};

/** Runs `fn` in its own transaction, or inside the caller's session (caller publishes). */
const run = async (
  fn: (session: ClientSession) => Promise<TxOutput>,
  outer?: ClientSession,
): Promise<TxOutput> => {
  if (outer) return fn(outer);
  return withTransaction(fn);
};

/** Publishes the change after commit (only when we own the transaction). */
const finish = async (out: TxOutput, outer?: ClientSession): Promise<EngineResult> => {
  if (outer) return { ...out.result, change: out.change };
  if (out.change) await publishWalletChange(out.change);
  return out.result;
};

const findByKey = (accountId: Types.ObjectId, key: string, session?: ClientSession) => {
  const q = LedgerEntryModel.findOne({ accountId, idempotencyKey: key });
  if (session) q.session(session);
  return q.lean<LedgerEntryDoc>();
};

const replay = async (
  accountId: Types.ObjectId,
  entries: LedgerEntryDoc[],
  session?: ClientSession,
): Promise<TxOutput> => {
  const q = WalletModel.findOne({ accountId });
  if (session) q.session(session);
  const wallet = await q.lean<WalletDoc>();
  if (!wallet) throw new Error('wallet missing');
  return { result: { entries, wallet, replay: true }, change: null };
};

/** Turns a lost unique-key race (E11000 on the idempotency key) into a replay. */
const raceSafe = async (
  accountId: Types.ObjectId,
  key: string,
  work: () => Promise<EngineResult>,
): Promise<EngineResult> => {
  try {
    return await work();
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await findByKey(accountId, key);
    if (!existing) throw err;
    return (await replay(accountId, [existing])).result;
  }
};

const insufficient = async (
  accountId: Types.ObjectId,
  amountMicros: number,
  session: ClientSession,
  { useCreditLimit, budget }: { useCreditLimit: boolean; budget?: 'call' | 'ai'; month?: string },
): Promise<never> => {
  const wallet = await WalletModel.findOne({ accountId }).session(session).lean<WalletDoc>();
  if (!wallet) throw new NotFoundError('Wallet not found');
  const available =
    wallet.balanceMicros - wallet.holdMicros + (useCreditLimit ? wallet.creditLimitMicros : 0);
  if (available >= amountMicros && budget) {
    throw new AppError('WALLET_BUDGET_EXCEEDED', undefined, [
      {
        path: 'amountMicros',
        message: `Monthly ${budget === 'ai' ? 'AI' : 'call'} budget reached`,
      },
    ]);
  }
  throw new AppError('WALLET_INSUFFICIENT_BALANCE', undefined, [
    {
      path: 'amountMicros',
      message: 'Not enough available balance',
      availableMicros: Math.max(available, 0),
    },
  ]);
};

/** `$expr` that is true when the wallet can spend `amount` (budget optional). */
const canSpend = (
  amount: number,
  {
    useCreditLimit,
    budget,
    month,
  }: { useCreditLimit: boolean; budget?: 'call' | 'ai'; month: string },
) => {
  const available = {
    $subtract: [
      { $add: ['$balanceMicros', useCreditLimit ? '$creditLimitMicros' : 0] },
      '$holdMicros',
    ],
  };
  const clauses: unknown[] = [{ $gte: [available, amount] }];
  if (budget) {
    const limit = budget === 'call' ? '$budgets.monthlyCallMicros' : '$budgets.monthlyAiMicros';
    const spent =
      budget === 'call'
        ? { $cond: [{ $eq: ['$spend.month', month] }, '$spend.callMicros', 0] }
        : {
            $cond: [
              { $eq: ['$spend.month', month] },
              { $add: ['$spend.aiMicros', '$spend.ttsMicros'] },
              0,
            ],
          };
    clauses.push({ $or: [{ $eq: [limit, 0] }, { $lte: [{ $add: [spent, amount] }, limit] }] });
  }
  return { $and: clauses };
};

/** Update pipeline: month rollover of `spend`, then the money deltas. */
const moneyPipeline = (
  month: string,
  d: { balance?: number; hold?: number; call?: number; ai?: number; tts?: number },
): PipelineStage[] =>
  [
    {
      $set: {
        spend: {
          $cond: [
            { $eq: ['$spend.month', month] },
            '$spend',
            { month, callMicros: 0, aiMicros: 0, ttsMicros: 0 },
          ],
        },
      },
    },
    {
      $set: {
        balanceMicros: { $add: ['$balanceMicros', d.balance ?? 0] },
        holdMicros: { $add: ['$holdMicros', d.hold ?? 0] },
        'spend.callMicros': { $add: ['$spend.callMicros', d.call ?? 0] },
        'spend.aiMicros': { $add: ['$spend.aiMicros', d.ai ?? 0] },
        'spend.ttsMicros': { $add: ['$spend.ttsMicros', d.tts ?? 0] },
        version: { $add: ['$version', 1] },
        updatedAt: '$$NOW',
      },
    },
  ] as PipelineStage[];

const updateWallet = (
  accountId: Types.ObjectId,
  session: ClientSession,
  pipeline: PipelineStage[],
  expr?: Record<string, unknown>,
) =>
  WalletModel.findOneAndUpdate({ accountId, ...(expr ? { $expr: expr } : {}) }, pipeline, {
    session,
    returnDocument: 'after',
    updatePipeline: true,
    timestamps: false,
  } as never).lean<WalletDoc>();

const insertRow = async (
  session: ClientSession,
  row: Partial<LedgerEntryDoc> & { accountId: Types.ObjectId },
): Promise<LedgerEntryDoc> => {
  const [doc] = await LedgerEntryModel.create([{ currency: 'INR', ...row }], { session });
  if (!doc) throw new Error('ledger insert returned nothing');
  return doc.toObject({ transform: false });
};

const releaseRows = async (
  ids: Types.ObjectId[],
  reason: string,
  session: ClientSession,
): Promise<void> => {
  const res = await LedgerEntryModel.updateMany(
    { _id: { $in: ids }, status: 'held' },
    { $set: { status: 'released', releasedAt: new Date(), releaseReason: reason } },
    { session, ledgerRelease: true } as never,
  );
  if (res.modifiedCount !== ids.length) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The hold changed meanwhile');
  }
};

// ─────────────────────────────── credit ───────────────────────────────

export interface CreditInput {
  accountId: Types.ObjectId | string;
  type: Extract<LedgerType, 'topup' | 'adjustment' | 'refund'>;
  amountMicros: number;
  ref: LedgerRef;
  idempotencyKey: string;
  note?: string | null;
  createdBy?: Types.ObjectId | string | null;
}

/**
 * Adds money (top-up, credit adjustment, refund reversal). Inside a caller's
 * session the wallet must already exist (transactions read a snapshot).
 */
export const credit = async (
  input: CreditInput,
  { session: outer }: { session?: ClientSession } = {},
): Promise<EngineResult> => {
  const accountId = oid(input.accountId);
  const amount = assertMicros(input.amountMicros);
  if (amount <= 0) throw new RangeError('Credit must be positive');
  await getOrCreateWallet(accountId);
  return raceSafe(accountId, input.idempotencyKey, async () => {
    const out = await run(async (session) => {
      const existing = await findByKey(accountId, input.idempotencyKey, session);
      if (existing) return replay(accountId, [existing], session);
      const month = await accountMonth(accountId, session);
      const wallet = await updateWallet(
        accountId,
        session,
        moneyPipeline(month, { balance: amount }),
      );
      if (!wallet) throw new NotFoundError('Wallet not found');
      const entry = await insertRow(session, {
        accountId,
        type: input.type,
        direction: 'credit',
        status: 'captured',
        amountMicros: amount,
        balanceAfterMicros: wallet.balanceMicros,
        ref: input.ref,
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
        createdBy: input.createdBy ? oid(input.createdBy) : null,
      });
      return {
        result: { entries: [entry], wallet, replay: false },
        change: change(accountId, wallet, amount, 0),
      };
    }, outer);
    return finish(out, outer);
  });
};

// ─────────────────────────────── holds ───────────────────────────────

export interface HoldInput {
  accountId: Types.ObjectId | string;
  ref: LedgerRef;
  idempotencyKey: string;
  /** Default: `callHoldMinutes` of call + AI at the account's prices. */
  estimateMicros?: number;
}

/** Reserves money for a call (may use the credit limit; counts against the call budget). */
export const holdForCall = async (input: HoldInput): Promise<EngineResult> => {
  const accountId = oid(input.accountId);
  const card = await effectiveRateCard(accountId);
  const amount = assertMicros(input.estimateMicros ?? holdEstimate(card));
  if (amount <= 0) throw new RangeError('Hold must be positive');
  await getOrCreateWallet(accountId);
  return raceSafe(accountId, input.idempotencyKey, async () => {
    const out = await run(async (session) => {
      const existing = await findByKey(accountId, input.idempotencyKey, session);
      if (existing) return replay(accountId, [existing], session);
      const month = await accountMonth(accountId, session);
      const rule = { useCreditLimit: true, budget: 'call' as const, month };
      const wallet = await updateWallet(
        accountId,
        session,
        moneyPipeline(month, { hold: amount }),
        canSpend(amount, rule),
      );
      if (!wallet) return insufficient(accountId, amount, session, rule);
      const entry = await insertRow(session, {
        accountId,
        type: 'call_charge',
        direction: 'debit',
        status: 'held',
        amountMicros: amount,
        ref: input.ref,
        rateCardId: new Types.ObjectId(card.id),
        idempotencyKey: input.idempotencyKey,
      });
      return {
        result: { entries: [entry], wallet, replay: false },
        change: change(accountId, wallet, 0, amount),
      };
    });
    return finish(out);
  });
};

const loadHold = async (
  accountId: Types.ObjectId,
  holdId: Types.ObjectId,
  session?: ClientSession,
): Promise<{ root: LedgerEntryDoc; held: LedgerEntryDoc[] }> => {
  const q = LedgerEntryModel.findOne({ _id: holdId, accountId, holdId: null });
  if (session) q.session(session);
  const root = await q.lean<LedgerEntryDoc>();
  if (
    !root ||
    root.type !== 'call_charge' ||
    root.direction !== 'debit' ||
    root.status === 'captured'
  ) {
    throw new NotFoundError('Hold not found');
  }
  const rows = LedgerEntryModel.find({
    accountId,
    status: 'held',
    $or: [{ _id: holdId }, { holdId }],
  });
  if (session) rows.session(session);
  const held = await rows.lean<LedgerEntryDoc[]>();
  return { root, held };
};

export interface ExtendInput {
  accountId: Types.ObjectId | string;
  holdId: Types.ObjectId | string;
  idempotencyKey: string;
  /** Default: `callHoldExtendMinutes` at the hold's prices. */
  addMicros?: number;
}

export type ExtendResult =
  | ({ ok: true } & EngineResult)
  | { ok: false; reason: 'insufficient' | 'budget'; availableMicros: number };

/**
 * Adds to a running call's hold. When the wallet can't pay, the call must
 * end gracefully (Phase 7) — this never throws for money reasons.
 */
export const extendHold = async (input: ExtendInput): Promise<ExtendResult> => {
  const accountId = oid(input.accountId);
  const holdId = oid(input.holdId);
  const { root } = await loadHold(accountId, holdId);
  if (root.status !== 'held') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This hold is already settled or released');
  }
  const card = await rateCardById(root.rateCardId ?? (await effectiveRateCard(accountId)).id);
  const amount = assertMicros(
    input.addMicros ?? holdEstimate(card, BILLING_LIMITS.callHoldExtendMinutes),
  );
  if (amount <= 0) throw new RangeError('Extension must be positive');
  try {
    const result = await raceSafe(accountId, input.idempotencyKey, async () => {
      const out = await run(async (session) => {
        const existing = await findByKey(accountId, input.idempotencyKey, session);
        if (existing) return replay(accountId, [existing], session);
        const current = await LedgerEntryModel.findById(holdId)
          .session(session)
          .lean<LedgerEntryDoc>();
        if (current?.status !== 'held') {
          throw new ConflictError(
            'CONFLICT_INVALID_STATE',
            'This hold is already settled or released',
          );
        }
        const month = await accountMonth(accountId, session);
        const rule = { useCreditLimit: true, budget: 'call' as const, month };
        const wallet = await updateWallet(
          accountId,
          session,
          moneyPipeline(month, { hold: amount }),
          canSpend(amount, rule),
        );
        if (!wallet) return insufficient(accountId, amount, session, rule);
        const entry = await insertRow(session, {
          accountId,
          type: 'call_charge',
          direction: 'debit',
          status: 'held',
          amountMicros: amount,
          ref: root.ref,
          holdId,
          rateCardId: root.rateCardId ?? null,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          result: { entries: [entry], wallet, replay: false },
          change: change(accountId, wallet, 0, amount),
        };
      });
      return finish(out);
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof AppError && err.code === 'WALLET_INSUFFICIENT_BALANCE') {
      return {
        ok: false,
        reason: 'insufficient',
        availableMicros: err.details?.[0]?.availableMicros ?? 0,
      };
    }
    if (err instanceof AppError && err.code === 'WALLET_BUDGET_EXCEEDED') {
      const wallet = await getOrCreateWallet(accountId);
      return {
        ok: false,
        reason: 'budget',
        availableMicros: Math.max(availableMicros(snapshot(wallet)), 0),
      };
    }
    throw err;
  }
};

export interface SettleInput {
  accountId: Types.ObjectId | string;
  holdId: Types.ObjectId | string;
  usage: CallUsage;
}

const SETTLED = 'settled';

/**
 * Ends a call: releases every row of the hold and inserts the real charge
 * (prices snapshotted on the hold). Never fails for lack of balance — an
 * overrun past the hold may take the balance below 0.
 */
export const settleCall = async (input: SettleInput): Promise<EngineResult> => {
  const accountId = oid(input.accountId);
  const holdId = oid(input.holdId);
  const key = `settle:${holdId.toString()}`;
  return raceSafe(accountId, key, async () => {
    const out = await run(async (session) => {
      const existing = await findByKey(accountId, key, session);
      if (existing) return replay(accountId, [existing], session);
      const { root, held } = await loadHold(accountId, holdId, session);
      if (root.status === 'released') {
        if (root.releaseReason === SETTLED) return replay(accountId, [], session);
        throw new ConflictError(
          'CONFLICT_INVALID_STATE',
          'This hold was released without a charge',
        );
      }
      const card = await rateCardById(root.rateCardId ?? (await effectiveRateCard(accountId)).id);
      const charge = callCharge(card, input.usage);
      const holdTotal = held.reduce((sum, r) => sum + r.amountMicros, 0);
      await releaseRows(
        held.map((r) => r._id),
        SETTLED,
        session,
      );
      const shares = spendShares(charge.breakdown);
      const month = await accountMonth(accountId, session);
      const wallet = await updateWallet(
        accountId,
        session,
        moneyPipeline(month, {
          balance: -charge.totalMicros,
          hold: -holdTotal,
          call: shares.callMicros,
          ai: shares.aiMicros,
          tts: shares.ttsMicros,
        }),
      );
      if (!wallet) throw new NotFoundError('Wallet not found');
      const entries: LedgerEntryDoc[] = [];
      if (charge.totalMicros > 0) {
        entries.push(
          await insertRow(session, {
            accountId,
            type: 'call_charge',
            direction: 'debit',
            status: 'captured',
            amountMicros: charge.totalMicros,
            balanceAfterMicros: wallet.balanceMicros,
            breakdown: charge.breakdown,
            ref: root.ref,
            holdId,
            rateCardId: root.rateCardId ?? null,
            idempotencyKey: key,
          }),
        );
      }
      if (charge.totalMicros > holdTotal) {
        getLogger().warn(
          {
            accountId: accountId.toString(),
            holdId: holdId.toString(),
            overrunMicros: charge.totalMicros - holdTotal,
          },
          'billing: call charge exceeded its hold',
        );
      }
      return {
        result: { entries, wallet, replay: false },
        change: change(accountId, wallet, -charge.totalMicros, -holdTotal),
      };
    });
    return finish(out);
  });
};

/** Releases a hold without a charge (unanswered, failed, stale). No-op if already released. */
export const releaseHold = async (input: {
  accountId: Types.ObjectId | string;
  holdId: Types.ObjectId | string;
  reason: string;
}): Promise<EngineResult> => {
  const accountId = oid(input.accountId);
  const holdId = oid(input.holdId);
  const out = await run(async (session) => {
    const { root, held } = await loadHold(accountId, holdId, session);
    if (root.status !== 'held' || held.length === 0) return replay(accountId, [], session);
    const total = held.reduce((sum, r) => sum + r.amountMicros, 0);
    await releaseRows(
      held.map((r) => r._id),
      input.reason.slice(0, 60),
      session,
    );
    const month = await accountMonth(accountId, session);
    const wallet = await updateWallet(accountId, session, moneyPipeline(month, { hold: -total }));
    if (!wallet) throw new NotFoundError('Wallet not found');
    return {
      result: { entries: [], wallet, replay: false },
      change: change(accountId, wallet, 0, -total),
    };
  });
  return finish(out);
};

// ─────────────────────────────── direct charges ───────────────────────────────

export interface UsageInput {
  accountId: Types.ObjectId | string;
  type: Extract<LedgerType, 'ai_charge' | 'tts_charge'>;
  amountMicros: number;
  breakdown?: LedgerBreakdown;
  ref: LedgerRef;
  idempotencyKey: string;
}

/** AI / TTS usage outside a call hold — prepaid only (never the credit limit), AI budget. */
export const chargeUsage = async (input: UsageInput): Promise<EngineResult> => {
  const accountId = oid(input.accountId);
  const amount = assertMicros(input.amountMicros);
  if (amount <= 0) throw new RangeError('Charge must be positive');
  await getOrCreateWallet(accountId);
  return raceSafe(accountId, input.idempotencyKey, async () => {
    const out = await run(async (session) => {
      const existing = await findByKey(accountId, input.idempotencyKey, session);
      if (existing) return replay(accountId, [existing], session);
      const month = await accountMonth(accountId, session);
      const rule = { useCreditLimit: false, budget: 'ai' as const, month };
      const wallet = await updateWallet(
        accountId,
        session,
        moneyPipeline(month, {
          balance: -amount,
          ...(input.type === 'ai_charge' ? { ai: amount } : { tts: amount }),
        }),
        canSpend(amount, rule),
      );
      if (!wallet) return insufficient(accountId, amount, session, rule);
      const entry = await insertRow(session, {
        accountId,
        type: input.type,
        direction: 'debit',
        status: 'captured',
        amountMicros: amount,
        balanceAfterMicros: wallet.balanceMicros,
        breakdown: input.breakdown ?? null,
        ref: input.ref,
        idempotencyKey: input.idempotencyKey,
      });
      return {
        result: { entries: [entry], wallet, replay: false },
        change: change(accountId, wallet, -amount, 0),
      };
    });
    return finish(out);
  });
};

export interface AdjustInput {
  accountId: Types.ObjectId | string;
  direction: 'credit' | 'debit';
  amountMicros: number;
  reason: string;
  createdBy: Types.ObjectId | string;
  idempotencyKey: string;
  /** Debit below the available balance (rare correction). */
  allowNegative?: boolean;
}

/** Superadmin correction (credit or debit). Not counted in monthly spend. */
export const adjust = async (input: AdjustInput): Promise<EngineResult> => {
  if (input.direction === 'credit') {
    return credit({
      accountId: input.accountId,
      type: 'adjustment',
      amountMicros: input.amountMicros,
      ref: { type: 'manual', id: input.idempotencyKey.slice(0, 100) },
      idempotencyKey: input.idempotencyKey,
      note: input.reason,
      createdBy: input.createdBy,
    });
  }
  const accountId = oid(input.accountId);
  const amount = assertMicros(input.amountMicros);
  if (amount <= 0) throw new RangeError('Adjustment must be positive');
  await getOrCreateWallet(accountId);
  return raceSafe(accountId, input.idempotencyKey, async () => {
    const out = await run(async (session) => {
      const existing = await findByKey(accountId, input.idempotencyKey, session);
      if (existing) return replay(accountId, [existing], session);
      const month = await accountMonth(accountId, session);
      const rule = { useCreditLimit: false, month };
      const wallet = await updateWallet(
        accountId,
        session,
        moneyPipeline(month, { balance: -amount }),
        input.allowNegative ? undefined : canSpend(amount, rule),
      );
      if (!wallet) return insufficient(accountId, amount, session, rule);
      const entry = await insertRow(session, {
        accountId,
        type: 'adjustment',
        direction: 'debit',
        status: 'captured',
        amountMicros: amount,
        balanceAfterMicros: wallet.balanceMicros,
        ref: { type: 'manual', id: input.idempotencyKey.slice(0, 100) },
        idempotencyKey: input.idempotencyKey,
        note: input.reason,
        createdBy: oid(input.createdBy),
      });
      return {
        result: { entries: [entry], wallet, replay: false },
        change: change(accountId, wallet, -amount, 0),
      };
    });
    return finish(out);
  });
};
