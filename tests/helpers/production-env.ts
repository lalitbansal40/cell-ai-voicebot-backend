import { makeGstin } from '../../src/shared/gstin';

/** Payment, seller and AI variables a production env needs since Phases 4–5 (test values only). */
export const PRODUCTION_BILLING_ENV = {
  RAZORPAY_KEY_ID: 'rzp_test_example',
  RAZORPAY_KEY_SECRET: 'test-razorpay-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'test-razorpay-webhook-secret',
  BILLING_SELLER_NAME: 'Example Voice Pvt Ltd',
  BILLING_SELLER_ADDRESS: '1 Example Road, Jaipur, Rajasthan 302001',
  BILLING_SELLER_STATE_CODE: '08',
  BILLING_SELLER_GSTIN: makeGstin('08'),
  OPENAI_API_KEY: 'test-openai-key-not-real',
} as const;

/** A complete production env for building the app in tests (fake values, no network). */
export const PRODUCTION_APP_ENV = {
  NODE_ENV: 'production',
  APP_URL: 'https://api.example.com',
  FRONTEND_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  MONGODB_URI: 'mongodb://db.internal:27017/cav?replicaSet=rs0',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdefXYZ',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdefXYZ',
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'Cell AI Voicebot <no-reply@example.com>',
  ...PRODUCTION_BILLING_ENV,
} as const;
