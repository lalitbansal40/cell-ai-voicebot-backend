import { makeGstin } from '../../src/shared/gstin';

/** Payment + seller variables a production env needs since Phase 4 (test values only). */
export const PRODUCTION_BILLING_ENV = {
  RAZORPAY_KEY_ID: 'rzp_test_example',
  RAZORPAY_KEY_SECRET: 'test-razorpay-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'test-razorpay-webhook-secret',
  BILLING_SELLER_NAME: 'Example Voice Pvt Ltd',
  BILLING_SELLER_ADDRESS: '1 Example Road, Jaipur, Rajasthan 302001',
  BILLING_SELLER_STATE_CODE: '08',
  BILLING_SELLER_GSTIN: makeGstin('08'),
} as const;
