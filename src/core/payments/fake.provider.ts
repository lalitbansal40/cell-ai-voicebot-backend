import { randomBytes } from 'node:crypto';

import { hmacHex, safeEqualHex, type PaymentProvider, type ProviderPayment } from './types';

export interface FakePaymentProvider extends PaymentProvider {
  readonly name: 'fake';
  /** Test checkout: records a payment for an order and returns it + its checkout signature. */
  completePayment(input: { orderId: string; amountPaise: number; outcome: 'paid' | 'failed' }): {
    payment: ProviderPayment;
    signature: string;
  };
  /** Signs a webhook body like the real provider (used by `fake-complete`). */
  signWebhook(rawBody: Buffer): string;
}

const id = (prefix: string) => `${prefix}_fake_${randomBytes(8).toString('hex')}`;

/**
 * Dev / test / E2E stand-in for Razorpay (never in production — env rule).
 * Same signatures as the real one, keyed by FAKE_PAYMENT_SECRET.
 */
export const createFakePaymentProvider = (secret: string): FakePaymentProvider => {
  const payments = new Map<string, ProviderPayment>();
  return {
    name: 'fake',
    keyId: null,
    createOrder() {
      return Promise.resolve({ id: id('order'), status: 'created' });
    },
    fetchPayment(paymentId) {
      const p = payments.get(paymentId);
      return p
        ? Promise.resolve({ ...p })
        : Promise.reject(new Error(`Unknown fake payment ${paymentId}`));
    },
    capturePayment(paymentId) {
      const p = payments.get(paymentId);
      if (!p) return Promise.reject(new Error(`Unknown fake payment ${paymentId}`));
      p.status = 'captured';
      return Promise.resolve({ ...p });
    },
    verifyCheckoutSignature(orderId, paymentId, signature) {
      return safeEqualHex(hmacHex(secret, `${orderId}|${paymentId}`), signature);
    },
    verifyWebhookSignature(rawBody, signature) {
      return safeEqualHex(hmacHex(secret, rawBody), signature);
    },
    completePayment({ orderId, amountPaise, outcome }) {
      const payment: ProviderPayment = {
        id: id('pay'),
        orderId,
        status: outcome === 'paid' ? 'captured' : 'failed',
        amountPaise,
        currency: 'INR',
        errorDescription: outcome === 'paid' ? null : 'Test payment declined',
      };
      payments.set(payment.id, payment);
      return { payment: { ...payment }, signature: hmacHex(secret, `${orderId}|${payment.id}`) };
    },
    signWebhook(rawBody) {
      return hmacHex(secret, rawBody);
    },
  };
};
