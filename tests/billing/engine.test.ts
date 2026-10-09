import { MongoError } from 'mongodb';
import { Types } from 'mongoose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  adjust,
  chargeUsage,
  credit,
  extendHold,
  holdForCall,
  monthKey,
  releaseHold,
  settleCall,
} from '../../src/core/billing/engine';
import { resetWalletEventThrottle, walletEvents } from '../../src/core/billing/events';
import { invalidateRateCardCache } from '../../src/core/billing/rates';
import { AccountModel } from '../../src/db/models/account.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { withTransaction } from '../../src/db/transaction';
import { AppError, ConflictError, NotFoundError } from '../../src/shared/errors/app-error';
import { useTestDb } from '../helpers/db';

useTestDb();

const RUPEE = 1_000_000;
const admin = new Types.ObjectId();

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  walletEvents.removeAllListeners();
  resetWalletEventThrottle();
  invalidateRateCardCache();
});

let n = 0;
const newAccount = async (rupees = 0) => {
  n += 1;
  const account = await AccountModel.create({ name: `Engine ${n}`, slug: `engine-${n}` });
  if (rupees > 0) {
    await credit({
      accountId: account._id,
      type: 'topup',
      amountMicros: rupees * RUPEE,
      ref: { type: 'manual', id: 'seed' },
      idempotencyKey: `seed:${n}`,
    });
  }
  return account._id;
};
const wallet = async (accountId: Types.ObjectId) => {
  const w = await WalletModel.findOne({ accountId }).lean();
  if (!w) throw new Error('no wallet');
  return w;
};
const ref = (id = new Types.ObjectId().toString()) => ({ type: 'simulator' as const, id });

/** wallet == Σ ledger (the reconciliation invariant). */
const expectReconciled = async (accountId: Types.ObjectId) => {
  const rows = await LedgerEntryModel.find({ accountId }).lean();
  const captured = rows.filter((r) => r.status === 'captured');
  const balance =
    captured.filter((r) => r.direction === 'credit').reduce((s, r) => s + r.amountMicros, 0) -
    captured.filter((r) => r.direction === 'debit').reduce((s, r) => s + r.amountMicros, 0);
  const hold = rows.filter((r) => r.status === 'held').reduce((s, r) => s + r.amountMicros, 0);
  const w = await wallet(accountId);
  expect(w.balanceMicros).toBe(balance);
  expect(w.holdMicros).toBe(hold);
};

describe('credit', () => {
  it('adds money with a captured credit row and a balance snapshot; replays the key', async () => {
    const accountId = await newAccount();
    const updates: unknown[] = [];
    walletEvents.on('updated', (c) => updates.push(c));
    const first = await credit({
      accountId,
      type: 'topup',
      amountMicros: 1000 * RUPEE,
      ref: { type: 'topup', id: 'order-1' },
      idempotencyKey: 'topup:order-1',
      createdBy: admin,
    });
    expect(first.replay).toBe(false);
    expect(first.entries[0]).toMatchObject({
      type: 'topup',
      direction: 'credit',
      status: 'captured',
      amountMicros: 1000 * RUPEE,
      balanceAfterMicros: 1000 * RUPEE,
    });
    const again = await credit({
      accountId,
      type: 'topup',
      amountMicros: 5 * RUPEE, // different amount: still the stored row
      ref: { type: 'topup', id: 'order-1' },
      idempotencyKey: 'topup:order-1',
    });
    expect(again.replay).toBe(true);
    expect(again.entries[0]?._id.toString()).toBe(first.entries[0]?._id.toString());
    expect((await wallet(accountId)).balanceMicros).toBe(1000 * RUPEE);
    expect(updates).toHaveLength(1);
    await expect(
      credit({ accountId, type: 'topup', amountMicros: 0, ref: ref(), idempotencyKey: 'z' }),
    ).rejects.toThrow(RangeError);
  });

  it('creates the wallet if an old account has none', async () => {
    const accountId = new Types.ObjectId();
    await credit({
      accountId,
      type: 'adjustment',
      amountMicros: RUPEE,
      ref: ref(),
      idempotencyKey: 'x',
    });
    expect((await wallet(accountId)).balanceMicros).toBe(RUPEE);
  });

  it('runs inside a caller transaction without publishing', async () => {
    const accountId = await newAccount();
    const spy = vi.fn();
    walletEvents.on('updated', spy);
    await withTransaction((session) =>
      credit(
        { accountId, type: 'topup', amountMicros: RUPEE, ref: ref(), idempotencyKey: 'tx:1' },
        { session },
      ),
    );
    expect((await wallet(accountId)).balanceMicros).toBe(RUPEE);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('holds and settle', () => {
  it('holds 3 minutes of call + AI by default and settles a 90 s call at 2 minutes', async () => {
    const accountId = await newAccount(100);
    const held = await holdForCall({
      accountId,
      ref: ref('call-1'),
      idempotencyKey: 'hold:call-1',
    });
    const hold = held.entries[0];
    expect(hold).toMatchObject({ status: 'held', direction: 'debit', amountMicros: 21 * RUPEE });
    expect(hold?.rateCardId).toBeTruthy();
    expect((await wallet(accountId)).holdMicros).toBe(21 * RUPEE);

    const settled = await settleCall({
      accountId,
      holdId: hold?._id ?? '',
      usage: { answered: true, durationSec: 90 },
    });
    expect(settled.entries[0]).toMatchObject({
      type: 'call_charge',
      status: 'captured',
      amountMicros: 2 * RUPEE,
      balanceAfterMicros: 98 * RUPEE,
      ref: { type: 'simulator', id: 'call-1' },
      breakdown: { billableSeconds: 120, pulseSeconds: 60, telephonyMicros: 2 * RUPEE },
    });
    expect(settled.entries[0]?.holdId?.toString()).toBe(hold?._id.toString());
    const w = await wallet(accountId);
    expect(w.holdMicros).toBe(0);
    expect(w.balanceMicros).toBe(98 * RUPEE);
    expect(w.spend).toMatchObject({ callMicros: 2 * RUPEE, aiMicros: 0 });
    expect((await LedgerEntryModel.findById(hold?._id).lean())?.status).toBe('released');

    const again = await settleCall({
      accountId,
      holdId: hold?._id ?? '',
      usage: { answered: true, durationSec: 600 },
    });
    expect(again.replay).toBe(true);
    expect(again.entries[0]?._id.toString()).toBe(settled.entries[0]?._id.toString());
    expect((await releaseHold({ accountId, holdId: hold?._id ?? '', reason: 'late' })).replay).toBe(
      true,
    );
    await expectReconciled(accountId);
  });

  it('replays a hold key and refuses without balance (available in details) or over budget', async () => {
    const accountId = await newAccount(30);
    const first = await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:a' });
    const again = await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:a' });
    expect(again.replay).toBe(true);
    expect(again.entries[0]?._id.toString()).toBe(first.entries[0]?._id.toString());
    const err = await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:b' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('WALLET_INSUFFICIENT_BALANCE');
    expect((err as AppError).details?.[0]?.availableMicros).toBe(9 * RUPEE);
    expect(await LedgerEntryModel.countDocuments({ accountId, idempotencyKey: 'hold:b' })).toBe(0);

    await WalletModel.updateOne(
      { accountId },
      { $set: { 'budgets.monthlyCallMicros': 5 * RUPEE } },
    );
    const budget = await holdForCall({
      accountId,
      ref: ref(),
      idempotencyKey: 'hold:c',
      estimateMicros: 6 * RUPEE,
    }).catch((e: unknown) => e);
    expect((budget as AppError).code).toBe('WALLET_BUDGET_EXCEEDED');
    await expectReconciled(accountId);
  });

  it('lets holds use the credit limit', async () => {
    const accountId = await newAccount(10);
    await WalletModel.updateOne({ accountId }, { $set: { creditLimitMicros: 20 * RUPEE } });
    await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:credit' });
    expect((await wallet(accountId)).holdMicros).toBe(21 * RUPEE);
  });

  it('extends a hold with child rows and settles them all; refuses gracefully when broke', async () => {
    const accountId = await newAccount(60);
    const root = (await holdForCall({ accountId, ref: ref('long'), idempotencyKey: 'hold:long' }))
      .entries[0];
    const holdId = root?._id ?? '';
    const ext = await extendHold({
      accountId,
      holdId,
      idempotencyKey: `extend:${holdId.toString()}:1`,
    });
    expect(ext.ok).toBe(true);
    if (!ext.ok) throw new Error('expected ok');
    expect(ext.entries[0]).toMatchObject({ status: 'held', amountMicros: 14 * RUPEE });
    expect(ext.entries[0]?.holdId?.toString()).toBe(holdId.toString());
    const replayed = await extendHold({
      accountId,
      holdId,
      idempotencyKey: `extend:${holdId.toString()}:1`,
    });
    expect(replayed.ok && replayed.replay).toBe(true);
    await extendHold({ accountId, holdId, idempotencyKey: 'extend:2' });
    const broke = await extendHold({ accountId, holdId, idempotencyKey: 'extend:3' });
    expect(broke).toEqual({ ok: false, reason: 'insufficient', availableMicros: 11 * RUPEE });
    expect((await wallet(accountId)).holdMicros).toBe(49 * RUPEE);

    await settleCall({
      accountId,
      holdId,
      usage: { answered: true, durationSec: 300, aiSeconds: 300 },
    });
    expect(
      await LedgerEntryModel.countDocuments({
        accountId,
        status: 'released',
        releaseReason: 'settled',
      }),
    ).toBe(3);
    const w = await wallet(accountId);
    expect(w.holdMicros).toBe(0);
    expect(w.balanceMicros).toBe(60 * RUPEE - 35 * RUPEE);
    await expect(
      extendHold({ accountId, holdId, idempotencyKey: 'extend:4' }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expectReconciled(accountId);
  });

  it('reports a budget stop on extension', async () => {
    const accountId = await newAccount(100);
    const root = (await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:bud' }))
      .entries[0];
    await WalletModel.updateOne({ accountId }, { $set: { 'budgets.monthlyCallMicros': RUPEE } });
    const res = await extendHold({ accountId, holdId: root?._id ?? '', idempotencyKey: 'ext:bud' });
    expect(res).toMatchObject({ ok: false, reason: 'budget' });
  });

  it('releases an unanswered call without a charge; settle after release conflicts', async () => {
    const accountId = await newAccount(50);
    const root = (await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:na' }))
      .entries[0];
    const holdId = root?._id ?? '';
    await releaseHold({ accountId, holdId, reason: 'unanswered' });
    expect(await wallet(accountId)).toMatchObject({ holdMicros: 0, balanceMicros: 50 * RUPEE });
    expect((await releaseHold({ accountId, holdId, reason: 'again' })).replay).toBe(true);
    await expect(
      settleCall({ accountId, holdId, usage: { answered: true, durationSec: 10 } }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expectReconciled(accountId);
  });

  it('settles an unanswered call to zero (no charge row) and replays it', async () => {
    const accountId = await newAccount(50);
    const holdId =
      (await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:zero' })).entries[0]?._id ??
      '';
    const res = await settleCall({
      accountId,
      holdId,
      usage: { answered: false, durationSec: 20 },
    });
    expect(res.entries).toEqual([]);
    expect((await wallet(accountId)).balanceMicros).toBe(50 * RUPEE);
    expect(
      (await settleCall({ accountId, holdId, usage: { answered: false, durationSec: 20 } })).replay,
    ).toBe(true);
  });

  it('allows an overrun past the hold (balance below 0), then refuses new holds until a top-up', async () => {
    const accountId = await newAccount(5);
    const holdId =
      (
        await holdForCall({
          accountId,
          ref: ref(),
          idempotencyKey: 'hold:over',
          estimateMicros: 5 * RUPEE,
        })
      ).entries[0]?._id ?? '';
    await settleCall({ accountId, holdId, usage: { answered: true, durationSec: 600 } });
    expect((await wallet(accountId)).balanceMicros).toBe(-5 * RUPEE);
    await expect(
      holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:after', estimateMicros: RUPEE }),
    ).rejects.toMatchObject({ code: 'WALLET_INSUFFICIENT_BALANCE' });
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 10 * RUPEE,
      ref: ref(),
      idempotencyKey: 'tp',
    });
    await holdForCall({
      accountId,
      ref: ref(),
      idempotencyKey: 'hold:after',
      estimateMicros: RUPEE,
    });
    await expectReconciled(accountId);
  });

  it('refuses unknown holds and holds of another account', async () => {
    const a = await newAccount(50);
    const b = await newAccount(50);
    const holdId =
      (await holdForCall({ accountId: a, ref: ref(), idempotencyKey: 'hold:own' })).entries[0]
        ?._id ?? '';
    await expect(
      settleCall({ accountId: b, holdId, usage: { answered: true, durationSec: 1 } }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      releaseHold({ accountId: a, holdId: new Types.ObjectId(), reason: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(extendHold({ accountId: b, holdId, idempotencyKey: 'e' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe('direct charges and adjustments', () => {
  it('charges AI / TTS prepaid only (never on credit), against the AI budget', async () => {
    const accountId = await newAccount(10);
    await WalletModel.updateOne({ accountId }, { $set: { creditLimitMicros: 100 * RUPEE } });
    await chargeUsage({
      accountId,
      type: 'ai_charge',
      amountMicros: 4 * RUPEE,
      ref: ref(),
      idempotencyKey: 'u1',
    });
    await chargeUsage({
      accountId,
      type: 'tts_charge',
      amountMicros: RUPEE,
      ref: ref(),
      idempotencyKey: 'u2',
    });
    expect((await wallet(accountId)).spend).toMatchObject({
      aiMicros: 4 * RUPEE,
      ttsMicros: RUPEE,
    });
    await expect(
      chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: 6 * RUPEE,
        ref: ref(),
        idempotencyKey: 'u3',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_INSUFFICIENT_BALANCE' });
    await WalletModel.updateOne({ accountId }, { $set: { 'budgets.monthlyAiMicros': 6 * RUPEE } });
    await expect(
      chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: 2 * RUPEE,
        ref: ref(),
        idempotencyKey: 'u4',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_BUDGET_EXCEEDED' });
    expect(
      (
        await chargeUsage({
          accountId,
          type: 'ai_charge',
          amountMicros: 4 * RUPEE,
          ref: ref(),
          idempotencyKey: 'u1',
        })
      ).replay,
    ).toBe(true);
    await expect(
      chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: 0,
        ref: ref(),
        idempotencyKey: 'u0',
      }),
    ).rejects.toThrow(RangeError);
    await expectReconciled(accountId);
  });

  it('adjusts by credit or debit (negative only when allowed)', async () => {
    const accountId = await newAccount(10);
    const credited = await adjust({
      accountId,
      direction: 'credit',
      amountMicros: 5 * RUPEE,
      reason: 'Goodwill credit',
      createdBy: admin,
      idempotencyKey: 'adj-1',
    });
    expect(credited.entries[0]).toMatchObject({
      type: 'adjustment',
      direction: 'credit',
      note: 'Goodwill credit',
    });
    await expect(
      adjust({
        accountId,
        direction: 'debit',
        amountMicros: 20 * RUPEE,
        reason: 'Fix',
        createdBy: admin,
        idempotencyKey: 'adj-2',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_INSUFFICIENT_BALANCE' });
    const debited = await adjust({
      accountId,
      direction: 'debit',
      amountMicros: 20 * RUPEE,
      reason: 'Correction',
      createdBy: admin,
      idempotencyKey: 'adj-3',
      allowNegative: true,
    });
    expect(debited.entries[0]).toMatchObject({
      direction: 'debit',
      balanceAfterMicros: -5 * RUPEE,
    });
    expect(
      (
        await adjust({
          accountId,
          direction: 'debit',
          amountMicros: 1,
          reason: 'x',
          createdBy: admin,
          idempotencyKey: 'adj-3',
        })
      ).replay,
    ).toBe(true);
    await expect(
      adjust({
        accountId,
        direction: 'debit',
        amountMicros: 0,
        reason: 'x',
        createdBy: admin,
        idempotencyKey: 'adj-4',
      }),
    ).rejects.toThrow(RangeError);
    expect((await wallet(accountId)).spend.callMicros).toBe(0); // adjustments aren't spend
    await expectReconciled(accountId);
  });
});

describe('month spend', () => {
  it('computes the month in the account timezone', () => {
    expect(monthKey(new Date('2026-10-31T18:29:59Z'), 'Asia/Kolkata')).toBe('2026-10');
    expect(monthKey(new Date('2026-10-31T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-11');
  });

  it('resets the counters when a new month starts', async () => {
    const accountId = await newAccount(100);
    await WalletModel.updateOne(
      { accountId },
      { $set: { spend: { month: '2000-01', callMicros: 9, aiMicros: 9, ttsMicros: 9 } } },
    );
    await chargeUsage({
      accountId,
      type: 'ai_charge',
      amountMicros: RUPEE,
      ref: ref(),
      idempotencyKey: 'm1',
    });
    const w = await wallet(accountId);
    expect(w.spend).toMatchObject({ callMicros: 0, aiMicros: RUPEE, ttsMicros: 0 });
    expect(w.spend.month).toMatch(/^\d{4}-\d{2}$/);
    expect(w.spend.month).not.toBe('2000-01');
  });
});

describe('concurrency and failure safety', () => {
  it('50 parallel holds against a balance for 10: exactly 10 succeed, never negative', async () => {
    const accountId = await newAccount(10);
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, (_, i) =>
        holdForCall({
          accountId,
          ref: ref(`p${i}`),
          idempotencyKey: `hold:p${i}`,
          estimateMicros: RUPEE,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(failed.every((r) => (r.reason as AppError).code === 'WALLET_INSUFFICIENT_BALANCE')).toBe(
      true,
    );
    const w = await wallet(accountId);
    expect(w.holdMicros).toBe(10 * RUPEE);
    expect(w.balanceMicros - w.holdMicros).toBe(0);
    await expectReconciled(accountId);
  }, 60_000);

  it('20 parallel AI charges racing a credit never overdraw', async () => {
    const accountId = await newAccount(5);
    const work = [
      ...Array.from({ length: 20 }, (_, i) =>
        chargeUsage({
          accountId,
          type: 'ai_charge',
          amountMicros: RUPEE,
          ref: ref(),
          idempotencyKey: `c${i}`,
        }),
      ),
      credit({
        accountId,
        type: 'topup',
        amountMicros: 5 * RUPEE,
        ref: ref(),
        idempotencyKey: 'race-topup',
      }),
    ];
    const results = await Promise.allSettled(work);
    const ok = results.slice(0, 20).filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeGreaterThanOrEqual(5);
    expect(ok).toBeLessThanOrEqual(10);
    const w = await wallet(accountId);
    expect(w.balanceMicros).toBe(10 * RUPEE - ok * RUPEE);
    expect(w.balanceMicros).toBeGreaterThanOrEqual(0);
    await expectReconciled(accountId);
  }, 60_000);

  it('the same idempotency key in parallel has one effect', async () => {
    const accountId = await newAccount();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        credit({
          accountId,
          type: 'topup',
          amountMicros: RUPEE,
          ref: ref(),
          idempotencyKey: 'same',
        }),
      ),
    );
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect((await wallet(accountId)).balanceMicros).toBe(RUPEE);
  }, 60_000);

  it('parallel settle and release of one hold: one wins, books stay consistent', async () => {
    const accountId = await newAccount(50);
    const holdId =
      (await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:race' })).entries[0]?._id ??
      '';
    await Promise.allSettled([
      settleCall({ accountId, holdId, usage: { answered: true, durationSec: 60 } }),
      releaseHold({ accountId, holdId, reason: 'failed' }),
    ]);
    const w = await wallet(accountId);
    expect(w.holdMicros).toBe(0);
    expect([49 * RUPEE, 50 * RUPEE]).toContain(w.balanceMicros);
    await expectReconciled(accountId);
  }, 60_000);

  it('rolls back the wallet change when the ledger insert fails', async () => {
    const accountId = await newAccount(10);
    vi.spyOn(LedgerEntryModel, 'create').mockRejectedValueOnce(new Error('disk full'));
    await expect(
      chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: RUPEE,
        ref: ref(),
        idempotencyKey: 'boom',
      }),
    ).rejects.toThrow('disk full');
    expect((await wallet(accountId)).balanceMicros).toBe(10 * RUPEE);
    await expectReconciled(accountId);
  });

  it('a transient transaction error is retried with a single effect and a single event', async () => {
    const accountId = await newAccount(10);
    const transient = new MongoError('write conflict');
    transient.addErrorLabel('TransientTransactionError');
    const real = LedgerEntryModel.create.bind(LedgerEntryModel);
    let calls = 0;
    vi.spyOn(LedgerEntryModel, 'create').mockImplementation((...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 1) return Promise.reject(transient);
      return real(...args);
    });
    const events = vi.fn();
    walletEvents.on('updated', events);
    await chargeUsage({
      accountId,
      type: 'ai_charge',
      amountMicros: RUPEE,
      ref: ref(),
      idempotencyKey: 'retry',
    });
    expect(calls).toBe(2);
    expect(events).toHaveBeenCalledTimes(1);
    expect((await wallet(accountId)).balanceMicros).toBe(9 * RUPEE);
    await expectReconciled(accountId);
  });
});

describe('race paths', () => {
  it('turns a duplicate-key insert into a replay of the stored row', async () => {
    const accountId = await newAccount(10);
    const first = await chargeUsage({
      accountId,
      type: 'ai_charge',
      amountMicros: RUPEE,
      ref: ref(),
      idempotencyKey: 'dup',
    });
    // The pre-check misses (another process inserted just now) → E11000 → replay.
    const realFindOne = LedgerEntryModel.findOne.bind(LedgerEntryModel);
    let misses = 0;
    vi.spyOn(LedgerEntryModel, 'findOne').mockImplementation(((
      ...args: Parameters<typeof realFindOne>
    ) => {
      const filter = args[0] as { idempotencyKey?: string } | undefined;
      if (filter?.idempotencyKey === 'dup' && misses < 1) {
        misses += 1;
        return realFindOne({ _id: new Types.ObjectId() });
      }
      return realFindOne(...args);
    }) as never);
    const again = await chargeUsage({
      accountId,
      type: 'ai_charge',
      amountMicros: RUPEE,
      ref: ref(),
      idempotencyKey: 'dup',
    });
    expect(again.replay).toBe(true);
    expect(again.entries[0]?._id.toString()).toBe(first.entries[0]?._id.toString());
    expect((await wallet(accountId)).balanceMicros).toBe(9 * RUPEE);
  });

  it('rethrows a duplicate-key error that is not about the idempotency key', async () => {
    const accountId = await newAccount(10);
    vi.spyOn(LedgerEntryModel, 'create').mockRejectedValueOnce(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
    );
    await expect(
      chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: RUPEE,
        ref: ref(),
        idempotencyKey: 'other',
      }),
    ).rejects.toThrow('E11000');
    expect((await wallet(accountId)).balanceMicros).toBe(10 * RUPEE);
  });

  it('refuses when the hold changed during the release', async () => {
    const accountId = await newAccount(50);
    const holdId =
      (await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:chg' })).entries[0]?._id ??
      '';
    vi.spyOn(LedgerEntryModel, 'updateMany').mockResolvedValueOnce({ modifiedCount: 0 } as never);
    await expect(releaseHold({ accountId, holdId, reason: 'x' })).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect((await wallet(accountId)).holdMicros).toBe(21 * RUPEE);
  });

  it('refuses an extension when the hold was released meanwhile', async () => {
    const accountId = await newAccount(100);
    const holdId =
      (await holdForCall({ accountId, ref: ref(), idempotencyKey: 'hold:ext-race' })).entries[0]
        ?._id ?? '';
    const realFindById = LedgerEntryModel.findById.bind(LedgerEntryModel);
    vi.spyOn(LedgerEntryModel, 'findById').mockImplementationOnce(((id: unknown) => {
      const q = realFindById(id as never);
      return q.transform((doc: unknown) => (doc ? { ...doc, status: 'released' } : doc));
    }) as never);
    await expect(
      extendHold({ accountId, holdId, idempotencyKey: 'ext:race' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
