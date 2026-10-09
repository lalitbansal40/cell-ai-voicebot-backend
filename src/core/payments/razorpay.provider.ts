import { BILLING_LIMITS } from '../../config/limits';
import { AppError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import {
  hmacHex,
  safeEqualHex,
  type PaymentProvider,
  type ProviderPayment,
  type ProviderPaymentStatus,
} from './types';

interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Overridable for tests (local stub server). */
  baseUrl?: string;
}

interface RawPayment {
  id: string;
  order_id?: string | null;
  status: ProviderPaymentStatus;
  amount: number;
  currency: string;
  error_description?: string | null;
}

const toPayment = (p: RawPayment): ProviderPayment => ({
  id: p.id,
  orderId: p.order_id ?? null,
  status: p.status,
  amountPaise: p.amount,
  currency: p.currency,
  errorDescription: p.error_description ?? null,
});

/** Minimal Razorpay REST client (no SDK) — orders, payments, capture, signatures. */
export const createRazorpayProvider = ({
  keyId,
  keySecret,
  webhookSecret,
  baseUrl = 'https://api.razorpay.com/v1',
}: RazorpayOptions): PaymentProvider => {
  const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: auth,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(BILLING_LIMITS.providerTimeoutMs),
      });
    } catch (err) {
      getLogger().warn({ path, err: (err as Error).name }, 'razorpay: request failed');
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'The payment gateway is not reachable. Try again.',
      );
    }
    const json = (await res.json().catch(() => null)) as
      (T & { error?: { code?: string; description?: string } }) | null;
    if (res.status >= 500) {
      getLogger().warn({ path, status: res.status }, 'razorpay: server error');
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'The payment gateway is not available. Try again.',
      );
    }
    if (!res.ok || !json) {
      getLogger().warn(
        {
          path,
          status: res.status,
          code: json?.error?.code,
          description: json?.error?.description,
        },
        'razorpay: request rejected',
      );
      throw new AppError('PROVIDER_ERROR', 'The payment gateway refused the request.');
    }
    return json;
  };

  return {
    name: 'razorpay',
    keyId,
    async createOrder({ amountPaise, receipt, notes }) {
      const order = await call<{ id: string; status: string }>('POST', '/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt: receipt.slice(0, 40),
        notes,
      });
      return { id: order.id, status: order.status };
    },
    async fetchPayment(paymentId) {
      return toPayment(await call<RawPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`));
    },
    async capturePayment(paymentId, amountPaise) {
      return toPayment(
        await call<RawPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, {
          amount: amountPaise,
          currency: 'INR',
        }),
      );
    },
    verifyCheckoutSignature(orderId, paymentId, signature) {
      return safeEqualHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
    },
    verifyWebhookSignature(rawBody, signature) {
      return safeEqualHex(hmacHex(webhookSecret, rawBody), signature);
    },
  };
};
