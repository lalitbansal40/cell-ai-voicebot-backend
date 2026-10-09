import type { Env } from '../../config/env';

import { createFakePaymentProvider } from './fake.provider';
import { createRazorpayProvider } from './razorpay.provider';
import type { PaymentProvider } from './types';

export * from './types';
export { createFakePaymentProvider, type FakePaymentProvider } from './fake.provider';
export { createRazorpayProvider } from './razorpay.provider';

/** The provider chosen by `PAYMENT_PROVIDER` (env validation guarantees the keys). */
export const createPaymentProvider = (
  env: Pick<
    Env,
    | 'PAYMENT_PROVIDER'
    | 'FAKE_PAYMENT_SECRET'
    | 'RAZORPAY_KEY_ID'
    | 'RAZORPAY_KEY_SECRET'
    | 'RAZORPAY_WEBHOOK_SECRET'
  >,
  { baseUrl }: { baseUrl?: string } = {},
): PaymentProvider => {
  if (env.PAYMENT_PROVIDER === 'fake') {
    return createFakePaymentProvider(env.FAKE_PAYMENT_SECRET ?? 'dev-fake-payment-secret');
  }
  return createRazorpayProvider({
    keyId: env.RAZORPAY_KEY_ID ?? '',
    keySecret: env.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? '',
    ...(baseUrl ? { baseUrl } : {}),
  });
};
