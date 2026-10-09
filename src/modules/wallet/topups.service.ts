import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { getEnv } from '../../config/env';
import { computeTopupTax } from '../../core/billing/gst';
import type { BillingJobs } from '../../core/billing/jobs';
import { creditTopup } from '../../core/billing/topup-credit';
import type { FakePaymentProvider, PaymentProvider, ProviderPayment } from '../../core/payments';
import { TopupOrderModel, type TopupOrderDoc } from '../../db/models/topup-order.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { microsToPaise } from '../../shared/money';
import type { AuditActorInput } from '../audit/audit.service';
import { loadBillingProfile } from '../billing/profile.service';

import type {
  CreateTopupBody,
  FakeCompleteBody,
  ListTopupsQuery,
  VerifyTopupBody,
} from './topups.schema';

export interface TopupDeps {
  payments: PaymentProvider;
  jobs: BillingJobs;
}

export const toTopupView = (o: TopupOrderDoc) => ({
  id: o._id.toString(),
  provider: o.provider,
  providerOrderId: o.providerOrderId ?? null,
  status: o.status,
  baseMicros: o.baseMicros,
  cgstMicros: o.cgstMicros,
  sgstMicros: o.sgstMicros,
  igstMicros: o.igstMicros,
  taxMicros: o.taxMicros,
  totalMicros: o.totalMicros,
  currency: 'INR' as const,
  failureReason: o.failureReason ?? null,
  paidAt: o.paidAt ? o.paidAt.toISOString() : null,
  invoiceId: o.invoiceId ? o.invoiceId.toString() : null,
  createdAt: o.createdAt.toISOString(),
});

const actorOf = (req: Request): AuditActorInput => {
  const auth = requireAuth(req);
  return { type: 'user', id: auth.userId ?? null, impersonatorId: auth.impersonatorId ?? null };
};

/** Step 1: order saved first (`creating`), then the gateway order (outside any transaction). */
export const createTopup = async (
  req: Request,
  body: z.infer<typeof CreateTopupBody>,
  { payments }: TopupDeps,
) => {
  const { accountId } = tenantFilter(req);
  const auth = requireAuth(req);
  const profile = await loadBillingProfile(accountId);
  if (!profile?.legalName || !profile.stateCode) throw new AppError('BILLING_PROFILE_REQUIRED');
  const amounts = computeTopupTax(
    body.amountMicros,
    getEnv().BILLING_SELLER_STATE_CODE,
    profile.stateCode,
  );
  const { updatedAt: _updatedAt, ...buyer } = profile;
  const order = await TopupOrderModel.create({
    accountId,
    provider: payments.name,
    status: 'creating',
    ...amounts,
    buyer,
    createdBy: new Types.ObjectId(auth.userId),
  });
  const amountPaise = microsToPaise(amounts.totalMicros);
  let providerOrderId: string;
  try {
    const created = await payments.createOrder({
      amountPaise,
      receipt: order._id.toString(),
      notes: { accountId: accountId.toString(), topupOrderId: order._id.toString() },
    });
    providerOrderId = created.id;
  } catch (err) {
    await TopupOrderModel.updateOne(
      { _id: order._id, status: 'creating' },
      { $set: { status: 'failed', failureReason: 'provider_error' } },
    );
    throw err;
  }
  const saved = await TopupOrderModel.findOneAndUpdate(
    { _id: order._id, status: 'creating' },
    { $set: { status: 'created', providerOrderId } },
    { returnDocument: 'after' },
  ).lean<TopupOrderDoc>();
  if (!saved) throw new ConflictError('CONFLICT_INVALID_STATE', 'The order changed meanwhile');
  return {
    topupOrder: toTopupView(saved),
    checkout: {
      provider: payments.name,
      keyId: payments.keyId,
      providerOrderId,
      amountPaise,
      currency: 'INR' as const,
      name: 'Cell AI Voicebot',
      description: 'Wallet recharge',
      prefill: { name: profile.legalName, email: profile.email },
    },
  };
};

export const listTopups = async (
  accountId: Types.ObjectId,
  query: z.infer<typeof ListTopupsQuery>,
) => {
  const [rows, total] = await Promise.all([
    TopupOrderModel.find({ accountId })
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<TopupOrderDoc[]>(),
    TopupOrderModel.countDocuments({ accountId }),
  ]);
  return {
    items: rows.map(toTopupView),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

const ownOrder = async (accountId: Types.ObjectId, id: string): Promise<TopupOrderDoc> => {
  const order = await TopupOrderModel.findOne({ _id: id, accountId }).lean<TopupOrderDoc>();
  if (!order) throw new NotFoundError('Top-up not found');
  return order;
};

export const getTopup = async (accountId: Types.ObjectId, id: string) =>
  toTopupView(await ownOrder(accountId, id));

const verificationFailed = (order: TopupOrderDoc, reason: string): never => {
  getLogger().warn(
    { topupOrderId: order._id.toString(), providerOrderId: order.providerOrderId, reason },
    'payments: verification failed',
  );
  throw new AppError('PAYMENT_VERIFICATION_FAILED');
};

/** The payment must be captured, for exactly this order's total, in INR. */
export const assertPaymentMatches = (order: TopupOrderDoc, payment: ProviderPayment): void => {
  if (payment.status !== 'captured') verificationFailed(order, `status ${payment.status}`);
  if (payment.orderId !== order.providerOrderId) verificationFailed(order, 'order mismatch');
  if (payment.currency !== 'INR') verificationFailed(order, 'currency mismatch');
  if (payment.amountPaise !== microsToPaise(order.totalMicros)) {
    verificationFailed(order, 'amount mismatch');
  }
};

/** Step 2 (browser): checkout signature → payment re-fetched (captured if needed) → credit. */
export const verifyTopup = async (
  req: Request,
  id: string,
  body: z.infer<typeof VerifyTopupBody>,
  { payments, jobs }: TopupDeps,
) => {
  const { accountId } = tenantFilter(req);
  const order = await ownOrder(accountId, id);
  if (order.status === 'paid') return toTopupView(order);
  if (order.status !== 'created' && order.status !== 'expired') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This top-up can no longer be paid');
  }
  if (
    !payments.verifyCheckoutSignature(
      order.providerOrderId ?? '',
      body.providerPaymentId,
      body.signature,
    )
  ) {
    verificationFailed(order, 'bad checkout signature');
  }
  let payment = await payments.fetchPayment(body.providerPaymentId);
  if (payment.status === 'authorized') {
    payment = await payments.capturePayment(payment.id, microsToPaise(order.totalMicros));
  }
  assertPaymentMatches(order, payment);
  const result = await creditTopup({
    orderId: order._id,
    payment,
    actor: actorOf(req),
    jobs,
    ip: req.ip ?? null,
  });
  return toTopupView(result.order);
};

/** Test payments: pay (same path as the browser checkout) or fail an order. */
export const fakeComplete = async (
  req: Request,
  id: string,
  body: z.infer<typeof FakeCompleteBody>,
  deps: TopupDeps,
) => {
  const fake = deps.payments as FakePaymentProvider;
  const { accountId } = tenantFilter(req);
  const order = await ownOrder(accountId, id);
  if (order.status !== 'created') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Only a new top-up can be completed');
  }
  const { payment, signature } = fake.completePayment({
    orderId: order.providerOrderId ?? '',
    amountPaise: microsToPaise(order.totalMicros),
    outcome: body.outcome,
  });
  if (body.outcome === 'failed') {
    const failed = await TopupOrderModel.findOneAndUpdate(
      { _id: order._id, status: 'created' },
      {
        $set: {
          status: 'failed',
          failureReason: payment.errorDescription,
          rawProviderStatus: 'failed',
        },
      },
      { returnDocument: 'after' },
    ).lean<TopupOrderDoc>();
    return toTopupView(failed ?? order);
  }
  return verifyTopup(req, id, { providerPaymentId: payment.id, signature }, deps);
};
