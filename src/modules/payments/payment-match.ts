import type { ProviderPayment } from '../../core/payments';
import type { TopupOrderDoc } from '../../db/models/topup-order.model';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { microsToPaise } from '../../shared/money';

export const verificationFailed = (order: TopupOrderDoc, reason: string): never => {
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
