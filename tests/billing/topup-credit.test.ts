import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { BillingJobs } from '../../src/core/billing/jobs';
import { creditTopup } from '../../src/core/billing/topup-credit';
import type { ProviderPayment } from '../../src/core/payments';
import { InvoiceModel } from '../../src/db/models/invoice.model';
import { TopupOrderModel, type TopupStatus } from '../../src/db/models/topup-order.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { ConflictError } from '../../src/shared/errors/app-error';
import { recordingBillingJobs } from '../helpers/billing';
import { useTestDb } from '../helpers/db';

useTestDb();
const RUPEE = 1_000_000;

const order = (status: TopupStatus = 'created') =>
  TopupOrderModel.create({
    accountId: new Types.ObjectId(),
    provider: 'fake',
    providerOrderId: `order_${new Types.ObjectId().toString()}`,
    status,
    baseMicros: 100 * RUPEE,
    igstMicros: 18 * RUPEE,
    taxMicros: 18 * RUPEE,
    totalMicros: 118 * RUPEE,
    buyer: {
      legalName: 'Test Co',
      email: 'b@example.com',
      addressLine1: '1 Road',
      city: 'Pune',
      stateCode: '27',
      pin: '411001',
    },
    createdBy: new Types.ObjectId(),
  });
const payment = (id = `pay_${new Types.ObjectId().toString()}`): ProviderPayment => ({
  id,
  orderId: null,
  status: 'captured',
  amountPaise: 11_800,
  currency: 'INR',
  errorDescription: null,
});
const system = { type: 'system' as const };

describe('creditTopup', () => {
  it('credits once; a second call returns the stored order and invoice', async () => {
    const rec = recordingBillingJobs();
    const o = await order();
    const pay = payment();
    const first = await creditTopup({
      orderId: o._id,
      payment: pay,
      actor: system,
      jobs: rec.jobs,
    });
    expect(first.credited).toBe(true);
    expect(first.invoice?.placeOfSupply).toEqual({ stateCode: '27', stateName: 'Maharashtra' });
    const second = await creditTopup({
      orderId: o._id,
      payment: pay,
      actor: system,
      jobs: rec.jobs,
    });
    expect(second.credited).toBe(false);
    expect(second.invoice?._id.toString()).toBe(first.invoice?._id.toString());
    expect((await WalletModel.findOne({ accountId: o.accountId }).lean())?.balanceMicros).toBe(
      100 * RUPEE,
    );
    expect(rec.queued).toHaveLength(1);
  });

  it('refuses an order that can no longer be paid', async () => {
    const o = await order('failed');
    await expect(
      creditTopup({
        orderId: o._id,
        payment: payment(),
        actor: system,
        jobs: recordingBillingJobs().jobs,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await InvoiceModel.countDocuments({ topupOrderId: o._id })).toBe(0);
  });

  it('still credits when the render job cannot be queued (logged)', async () => {
    const o = await order();
    const broken: BillingJobs = { enqueue: () => Promise.reject(new Error('redis down')) };
    const res = await creditTopup({
      orderId: o._id,
      payment: payment(),
      actor: system,
      jobs: broken,
    });
    expect(res.credited).toBe(true);
    expect((await TopupOrderModel.findById(o._id).lean())?.status).toBe('paid');
  });

  it('returns an already-paid order without an invoice link as is', async () => {
    const o = await order('paid');
    const res = await creditTopup({
      orderId: o._id,
      payment: payment(),
      actor: system,
      jobs: recordingBillingJobs().jobs,
    });
    expect(res).toMatchObject({ credited: false, invoice: null });
  });
});
