/**
 * DEV ONLY — Phase 4 demo billing for "Demo Finance" (called by db-seed.ts):
 * billing profile (state 08 Rajasthan, a fake GSTIN of the right format),
 * ₹1,000 opening credit, three simulated calls (held / charged / released)
 * and one fake top-up with its GST invoice. Everything goes through the real
 * billing engine with `seed:<name>` idempotency keys, so a re-run adds nothing.
 */
import type { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { credit, holdForCall, releaseHold, settleCall } from '../src/core/billing/engine';
import { computeTopupTax } from '../src/core/billing/gst';
import type { BillingJobs } from '../src/core/billing/jobs';
import { creditTopup } from '../src/core/billing/topup-credit';
import { AccountModel, type BillingProfile } from '../src/db/models/account.model';
import { LedgerEntryModel } from '../src/db/models/ledger-entry.model';
import { TopupOrderModel } from '../src/db/models/topup-order.model';
import { makeGstin } from '../src/shared/gstin';

const RUPEE = 1_000_000;
const SEED_ORDER_ID = 'order_seed_demo_finance';
const SEED_PAYMENT_ID = 'pay_seed_demo_finance';

export const DEMO_BILLING_PROFILE: Omit<BillingProfile, 'updatedAt'> = {
  legalName: 'Demo Finance Private Limited',
  email: 'billing@demo.local',
  addressLine1: '12 MI Road',
  addressLine2: 'Near Panch Batti',
  city: 'Jaipur',
  stateCode: '08',
  pin: '302001',
  gstin: makeGstin('08', 'AABCD1234E'),
};

/** Root row of a seeded hold (by its idempotency key), if it exists. */
const seededHold = (accountId: Types.ObjectId, key: string) =>
  LedgerEntryModel.findOne({ accountId, idempotencyKey: key }).select({ _id: 1 }).lean();

const simulatedHold = async (accountId: Types.ObjectId, name: string) => {
  const key = `seed:${name}`;
  const existing = await seededHold(accountId, key);
  if (existing) return { holdId: existing._id, created: false };
  const res = await holdForCall({
    accountId,
    ref: { type: 'simulator', id: name },
    idempotencyKey: key,
  });
  const root = res.entries[0];
  if (!root) throw new Error('seed hold produced no ledger row');
  return { holdId: root._id, created: !res.replay };
};

export interface BillingSeedResult {
  profile: boolean;
  openingCredit: boolean;
  calls: number;
  topup: boolean;
  invoiceNumber: string | null;
}

export const seedBilling = async (
  accountId: Types.ObjectId,
  {
    ownerId,
    adminId,
    jobs,
  }: { ownerId: Types.ObjectId; adminId: Types.ObjectId; jobs: BillingJobs },
): Promise<BillingSeedResult> => {
  const out: BillingSeedResult = {
    profile: false,
    openingCredit: false,
    calls: 0,
    topup: false,
    invoiceNumber: null,
  };

  const profiled = await AccountModel.updateOne(
    { _id: accountId, 'billing.legalName': { $exists: false } },
    { $set: { billing: { ...DEMO_BILLING_PROFILE, updatedAt: new Date() } } },
  );
  out.profile = profiled.modifiedCount === 1;

  const opening = await credit({
    accountId,
    type: 'adjustment',
    amountMicros: 1000 * RUPEE,
    ref: { type: 'seed', id: 'opening-credit' },
    idempotencyKey: 'seed:opening-credit',
    note: 'Seed opening credit',
    createdBy: adminId,
  });
  out.openingCredit = !opening.replay;

  // charged: answered 90 s with AI and TTS
  const charged = await simulatedHold(accountId, 'call-charged');
  await settleCall({
    accountId,
    holdId: charged.holdId,
    usage: { answered: true, durationSec: 90, aiSeconds: 85, ttsChars: 900 },
  });
  // released: unanswered
  const released = await simulatedHold(accountId, 'call-released');
  await releaseHold({ accountId, holdId: released.holdId, reason: 'unanswered' });
  // held: still "in progress" (the stale-hold reaper releases it after 2 h)
  const held = await simulatedHold(accountId, 'call-held');
  out.calls = [charged, released, held].filter((c) => c.created).length;

  let order = await TopupOrderModel.findOne({ accountId, providerOrderId: SEED_ORDER_ID }).lean();
  if (!order) {
    const amounts = computeTopupTax(
      500 * RUPEE,
      getEnv().BILLING_SELLER_STATE_CODE,
      DEMO_BILLING_PROFILE.stateCode,
    );
    order = (
      await TopupOrderModel.create({
        accountId,
        provider: 'fake',
        providerOrderId: SEED_ORDER_ID,
        status: 'created',
        ...amounts,
        buyer: DEMO_BILLING_PROFILE,
        createdBy: ownerId,
      })
    ).toObject({ transform: false });
  }
  const paid = await creditTopup({
    orderId: order._id,
    payment: {
      id: SEED_PAYMENT_ID,
      orderId: SEED_ORDER_ID,
      status: 'captured',
      amountPaise: order.totalMicros / 10_000,
      currency: 'INR',
      errorDescription: null,
    },
    actor: { type: 'system' },
    jobs,
  });
  out.topup = paid.credited;
  out.invoiceNumber = paid.invoice?.number ?? null;
  return out;
};
