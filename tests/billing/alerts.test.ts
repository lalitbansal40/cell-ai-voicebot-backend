import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleWalletChange, registerWalletAlerts } from '../../src/core/billing/alerts';
import { chargeUsage, credit, holdForCall } from '../../src/core/billing/engine';
import { resetWalletEventThrottle, setWalletChangeHook } from '../../src/core/billing/events';
import { reapStaleHolds } from '../../src/core/billing/reaper';
import { reconcileWallets } from '../../src/core/billing/reconcile';
import { AccountModel } from '../../src/db/models/account.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { NotificationModel, type NotificationType } from '../../src/db/models/notification.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { UserModel } from '../../src/db/models/user.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';

useTestDb();
const sent = useCapturedEmail();
const RUPEE = 1_000_000;

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
});
beforeEach(() => {
  registerWalletAlerts();
  sent.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  resetWalletEventThrottle();
  setWalletChangeHook(() => undefined);
});

let n = 0;
const setup = async (rupees: number, thresholdRupees = 100) => {
  n += 1;
  const t: TestAccount = await createTestAccount({
    name: `Alert <b>Co</b> ${n}`,
    timezone: 'Asia/Kolkata',
  });
  const owner: TestUser = await t.addUser('owner');
  const viewer: TestUser = await t.addUser('viewer');
  await credit({
    accountId: t.account._id,
    type: 'topup',
    amountMicros: rupees * RUPEE,
    ref: { type: 'manual', id: 's' },
    idempotencyKey: `s${n}`,
  });
  await WalletModel.updateOne(
    { accountId: t.account._id },
    { $set: { lowBalanceThresholdMicros: thresholdRupees * RUPEE } },
  );
  return { accountId: t.account._id, owner, viewer };
};
const spend = (accountId: Types.ObjectId, rupees: number, key: string) =>
  chargeUsage({
    accountId,
    type: 'ai_charge',
    amountMicros: rupees * RUPEE,
    ref: { type: 'usage', id: key },
    idempotencyKey: key,
  });
const notes = (accountId: Types.ObjectId, type: NotificationType) =>
  NotificationModel.find({ accountId, type }).lean();

describe('low-balance alerts', () => {
  it('alerts once when crossing the threshold: bell for wallet.read, email for wallet.topup', async () => {
    const { accountId, owner } = await setup(150);
    await spend(accountId, 40, 'a1'); // 110 — still above
    expect(await notes(accountId, 'wallet.low_balance')).toHaveLength(0);
    await spend(accountId, 20, 'a2'); // 90 — crossed
    const rows = await notes(accountId, 'wallet.low_balance');
    expect(rows).toHaveLength(2); // owner + viewer
    expect(rows[0]).toMatchObject({ title: 'Wallet balance is low', link: '/wallet' });
    expect(rows[0]?.body).toContain('₹90.00 available — below your alert level of ₹100.00');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      template: 'wallet.low_balance',
      to: owner.user.email,
      vars: { available: '₹90.00', threshold: '₹100.00', exhausted: false },
    });
    expect(sent[0]?.dedupeKey).toMatch(/^wallet-low:/);
    await spend(accountId, 10, 'a3'); // still below: no repeat
    expect(await notes(accountId, 'wallet.low_balance')).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it('parallel debits that cross together alert once', async () => {
    const { accountId } = await setup(120);
    await Promise.all(Array.from({ length: 6 }, (_, i) => spend(accountId, 5, `p${i}`)));
    expect(await notes(accountId, 'wallet.low_balance')).toHaveLength(2);
    expect(sent).toHaveLength(1);
  });

  it('re-arms after recovering above the threshold, and caps at once per 24 h', async () => {
    const { accountId } = await setup(150);
    await spend(accountId, 60, 'r1'); // 90 → alert
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 50 * RUPEE,
      ref: { type: 'manual', id: 'r' },
      idempotencyKey: 'r-top',
    }); // 140 → recovered
    expect(
      (await WalletModel.findOne({ accountId }).lean())?.alerts.lowBalanceNotifiedAt,
    ).toBeNull();
    await spend(accountId, 60, 'r2'); // 80 → alert again
    expect(sent).toHaveLength(2);
    // without the re-arm, a second crossing inside 24 h is silent
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 50 * RUPEE,
      ref: { type: 'manual', id: 'r2' },
      idempotencyKey: 'r-top2',
    });
    await WalletModel.updateOne(
      { accountId },
      { $set: { 'alerts.lowBalanceNotifiedAt': new Date() } },
    );
    await spend(accountId, 60, 'r3');
    expect(sent).toHaveLength(2);
  });

  it('is off when the threshold is 0', async () => {
    const { accountId } = await setup(50, 0);
    await spend(accountId, 49, 'z1');
    expect(sent).toHaveLength(0);
  });

  it('sends the exhausted variant (not also "low") when the balance hits 0', async () => {
    const { accountId, owner } = await setup(150);
    await spend(accountId, 150, 'e1');
    expect(await notes(accountId, 'wallet.exhausted')).toHaveLength(2);
    expect(await notes(accountId, 'wallet.low_balance')).toHaveLength(0);
    expect(sent).toEqual([
      expect.objectContaining({
        to: owner.user.email,
        vars: expect.objectContaining({ exhausted: true }) as unknown,
      }),
    ]);
    expect(sent[0]?.dedupeKey).toMatch(/^wallet-exhausted:/);
    await credit({
      accountId,
      type: 'topup',
      amountMicros: 10 * RUPEE,
      ref: { type: 'manual', id: 'e' },
      idempotencyKey: 'e-top',
    });
    expect(
      (await WalletModel.findOne({ accountId }).lean())?.alerts.exhaustedNotifiedAt,
    ).toBeNull();
  });

  it('never throws (logs) when something fails', async () => {
    vi.spyOn(WalletModel, 'updateOne').mockRejectedValueOnce(new Error('db down'));
    await expect(
      handleWalletChange({
        accountId: new Types.ObjectId().toString(),
        before: {
          balanceMicros: 0,
          holdMicros: 0,
          creditLimitMicros: 0,
          lowBalanceThresholdMicros: 5,
        },
        after: {
          balanceMicros: 10,
          holdMicros: 0,
          creditLimitMicros: 0,
          lowBalanceThresholdMicros: 5,
        },
      }),
    ).resolves.toBeUndefined();
  });

  it('handles an account that no longer exists (defaults)', async () => {
    const accountId = new Types.ObjectId();
    await WalletModel.create({ accountId, balanceMicros: 50 * RUPEE });
    await handleWalletChange({
      accountId: accountId.toString(),
      before: {
        balanceMicros: 200 * RUPEE,
        holdMicros: 0,
        creditLimitMicros: 0,
        lowBalanceThresholdMicros: 100 * RUPEE,
      },
      after: {
        balanceMicros: 50 * RUPEE,
        holdMicros: 0,
        creditLimitMicros: 0,
        lowBalanceThresholdMicros: 100 * RUPEE,
      },
    });
    expect(sent).toHaveLength(0); // no users to email
    await WalletModel.deleteOne({ accountId }); // not a real wallet (no ledger) — keep reconcile clean
  });
});

describe('stale-hold reaper', () => {
  it('releases holds older than 2 h, leaves fresh ones, is idempotent', async () => {
    const { accountId } = await setup(500);
    const old = await holdForCall({
      accountId,
      ref: { type: 'simulator', id: 'old' },
      idempotencyKey: 'h-old',
    });
    await holdForCall({
      accountId,
      ref: { type: 'simulator', id: 'new' },
      idempotencyKey: 'h-new',
    });
    await LedgerEntryModel.collection.updateOne(
      { _id: old.entries[0]?._id },
      { $set: { createdAt: new Date(Date.now() - 3 * 3_600_000) } },
    );
    expect(await reapStaleHolds()).toEqual({ released: 1 });
    expect(await LedgerEntryModel.findById(old.entries[0]?._id).lean()).toMatchObject({
      status: 'released',
      releaseReason: 'stale',
    });
    expect((await WalletModel.findOne({ accountId }).lean())?.holdMicros).toBe(21 * RUPEE);
    expect(await reapStaleHolds()).toEqual({ released: 0 });
  });

  it('logs and continues when a release fails', async () => {
    const accountId = new Types.ObjectId();
    await LedgerEntryModel.create({
      accountId,
      type: 'call_charge',
      direction: 'debit',
      status: 'held',
      amountMicros: RUPEE,
      ref: { type: 'simulator', id: 'x' },
      idempotencyKey: 'broken',
    });
    await LedgerEntryModel.collection.updateOne(
      { idempotencyKey: 'broken' },
      { $set: { createdAt: new Date(Date.now() - 3 * 3_600_000) } },
    );
    // no wallet for this account → release fails → logged, not thrown
    expect(await reapStaleHolds()).toEqual({ released: 0 });
  });
});

describe('reconciliation', () => {
  it('is quiet when every wallet matches its ledger, reports tampering to superadmins', async () => {
    const platform = await AccountModel.create({
      name: 'Platform',
      slug: 'platform-r',
      isPlatform: true,
    });
    const root = await UserModel.create({
      accountId: platform._id,
      roleId: new Types.ObjectId(),
      name: 'Root',
      email: 'root-r@platform.local',
      status: 'active',
      platformRole: 'superadmin',
    });
    await LedgerEntryModel.collection.deleteMany({ idempotencyKey: 'broken' });
    const clean = await reconcileWallets();
    expect(clean.mismatches).toEqual([]);
    expect(clean.checked).toBeGreaterThan(0);
    expect(await NotificationModel.countDocuments({ userId: root._id })).toBe(0);

    const { accountId } = await setup(100);
    await WalletModel.updateOne({ accountId }, { $inc: { balanceMicros: 1, holdMicros: 2 } });
    const dirty = await reconcileWallets();
    expect(dirty.mismatches).toEqual([
      {
        accountId: accountId.toString(),
        field: 'balanceMicros',
        expected: 100 * RUPEE,
        actual: 100 * RUPEE + 1,
      },
      { accountId: accountId.toString(), field: 'holdMicros', expected: 0, actual: 2 },
    ]);
    const note = await NotificationModel.findOne({ userId: root._id }).lean();
    expect(note).toMatchObject({ type: 'billing.reconcile_mismatch', link: '/admin/billing' });
  });
});
