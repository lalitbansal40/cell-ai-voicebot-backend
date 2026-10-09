import { createHmac, timingSafeEqual } from 'node:crypto';

export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';

export interface ProviderOrder {
  id: string;
  status: string;
}

export interface ProviderPayment {
  id: string;
  orderId: string | null;
  status: ProviderPaymentStatus;
  amountPaise: number;
  currency: string;
  errorDescription: string | null;
}

/**
 * A payment gateway (PHASE_4_PLAN §1d): Razorpay in production, the fake
 * provider for dev / tests / E2E. Amounts are integer paise.
 */
export interface PaymentProvider {
  readonly name: 'razorpay' | 'fake';
  /** Public key id sent to the browser checkout (null for the fake provider). */
  readonly keyId: string | null;
  createOrder(input: {
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<ProviderOrder>;
  fetchPayment(paymentId: string): Promise<ProviderPayment>;
  capturePayment(paymentId: string, amountPaise: number): Promise<ProviderPayment>;
  /** Checkout handler signature: HMAC-SHA256(`orderId|paymentId`, key secret). */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean;
  /** Webhook signature: HMAC-SHA256(raw body, webhook secret). */
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

export const hmacHex = (secret: string, data: string | Buffer): string =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time compare of two hex strings (different lengths → false). */
export const safeEqualHex = (a: string, b: string): boolean => {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
};
