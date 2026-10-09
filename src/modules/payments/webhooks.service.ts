import { createHash } from 'node:crypto';

import type { BillingJobs } from '../../core/billing/jobs';
import { creditTopup } from '../../core/billing/topup-credit';
import type { PaymentProvider, ProviderPayment, ProviderPaymentStatus } from '../../core/payments';
import { isDuplicateKeyError } from '../../db/errors';
import {
  PAYMENT_EVENT_TTL_MS,
  PaymentEventModel,
  type PaymentEventOutcome,
} from '../../db/models/payment-event.model';
import { TopupOrderModel, type TopupOrderDoc } from '../../db/models/topup-order.model';
import { AppError, UnauthenticatedError, ValidationError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { notifyPlatform } from '../notifications/notifications.service';

import { assertPaymentMatches } from './payment-match';

interface RawPaymentEntity {
  id?: string;
  order_id?: string | null;
  status?: ProviderPaymentStatus;
  amount?: number;
  currency?: string;
  error_description?: string | null;
}

interface WebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: RawPaymentEntity };
    order?: { entity?: { id?: string } };
    refund?: { entity?: { payment_id?: string } };
  };
}

export interface WebhookResult {
  duplicate: boolean;
  outcome: PaymentEventOutcome;
}

const toPayment = (p: RawPaymentEntity): ProviderPayment => ({
  id: p.id ?? '',
  orderId: p.order_id ?? null,
  status: p.status ?? 'created',
  amountPaise: p.amount ?? -1,
  currency: p.currency ?? '',
  errorDescription: p.error_description ?? null,
});

const findOrder = (
  provider: PaymentProvider['name'],
  providerOrderId: string | null | undefined,
) =>
  providerOrderId
    ? TopupOrderModel.findOne({ provider, providerOrderId }).lean<TopupOrderDoc>()
    : Promise.resolve(null);

/**
 * Payment-gateway webhook (PHASE_4_PLAN §1d): signature on the RAW body
 * (timing-safe), event-id dedupe, then credit / fail / report. Always
 * answers quickly; never logs the body or the signature.
 */
export const handlePaymentWebhook = async ({
  payments,
  jobs,
  rawBody,
  signature,
  eventId,
}: {
  payments: PaymentProvider;
  jobs: BillingJobs;
  rawBody: Buffer;
  signature: string | undefined;
  eventId: string | undefined;
}): Promise<WebhookResult> => {
  if (!signature || !payments.verifyWebhookSignature(rawBody, signature)) {
    throw new UnauthenticatedError();
  }
  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody.toString('utf8')) as WebhookEvent;
  } catch {
    throw new ValidationError([{ path: 'body', message: 'Not JSON' }]);
  }
  const type = String(event.event ?? 'unknown').slice(0, 60);
  const id = eventId ?? `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
  const now = new Date();
  let row;
  try {
    row = await PaymentEventModel.create({
      provider: payments.name,
      eventId: id.slice(0, 100),
      type,
      receivedAt: now,
      expiresAt: new Date(now.getTime() + PAYMENT_EVENT_TTL_MS),
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) return { duplicate: true, outcome: 'received' };
    throw err;
  }

  const entity = event.payload?.payment?.entity ?? {};
  const payment = toPayment(entity);
  const providerOrderId = entity.order_id ?? event.payload?.order?.entity?.id ?? null;
  let outcome: PaymentEventOutcome = 'ignored';
  let order: TopupOrderDoc | null = null;

  if (type === 'payment.captured' || type === 'order.paid') {
    order = await findOrder(payments.name, providerOrderId);
    if (!order) {
      outcome = 'unmatched';
      await notifyPlatform({
        type: 'billing.payment_unmatched',
        title: 'Payment for an unknown order',
        body: `A ${type} event (${id}) did not match any top-up order.`,
        link: '/admin/billing',
      });
    } else {
      try {
        assertPaymentMatches(order, { ...payment, orderId: payment.orderId ?? providerOrderId });
        const result = await creditTopup({
          orderId: order._id,
          payment,
          actor: { type: 'system' },
          jobs,
        });
        outcome = result.credited ? 'credited' : 'duplicate_credit';
        if (order.status === 'expired') {
          getLogger().warn(
            { topupOrderId: order._id.toString() },
            'payments: late payment on an expired order credited',
          );
        }
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        outcome = 'mismatch';
        await notifyPlatform({
          type: 'billing.payment_mismatch',
          title: 'Payment did not match its top-up',
          body: `Event ${id} for order ${order._id.toString()} was not credited (${err.code}).`,
          link: '/admin/billing',
        });
      }
    }
  } else if (type === 'payment.failed') {
    order = await findOrder(payments.name, providerOrderId);
    if (order) {
      await TopupOrderModel.updateOne(
        { _id: order._id, status: { $in: ['created', 'expired'] } },
        {
          $set: {
            status: 'failed',
            failureReason: (payment.errorDescription ?? 'Payment failed').slice(0, 200),
            rawProviderStatus: 'failed',
          },
        },
      );
    }
    outcome = order ? 'failed' : 'unmatched';
  } else if (type.startsWith('refund.')) {
    outcome = 'refund';
    await notifyPlatform({
      type: 'billing.refund_received',
      title: 'A payment was refunded at the gateway',
      body: `Event ${type} (${id}). Adjust the wallet by hand if needed.`,
      link: '/admin/billing',
    });
  }

  await PaymentEventModel.updateOne(
    { _id: row._id },
    {
      $set: {
        outcome,
        processedAt: new Date(),
        accountId: order?.accountId ?? null,
        topupOrderId: order?._id ?? null,
        providerOrderId: providerOrderId ?? null,
        providerPaymentId: payment.id || null,
      },
    },
  );
  getLogger().info({ eventId: id, type, outcome }, 'payments: webhook processed');
  return { duplicate: false, outcome };
};
