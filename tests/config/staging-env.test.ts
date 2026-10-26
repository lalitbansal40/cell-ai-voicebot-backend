import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENV_KEYS, loadEnv } from '../../src/config/env';
import { makeGstin } from '../../src/shared/gstin';

const root = path.resolve(__dirname, '..', '..');
const template = readFileSync(path.join(root, 'deploy/staging/env.example'), 'utf8');

/** `KEY=value` lines of the template (quotes removed, comments skipped). */
const entries = (): [string, string][] =>
  [...template.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gm)].map((m) => [
    m[1] ?? '',
    (m[2] ?? '').replace(/^"(.*)"$/, '$1'),
  ]);

/** What the owner fills in: placeholders + secrets with format-valid test values. */
const filled = (over: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const secrets: Record<string, string> = {
    JWT_ACCESS_SECRET: 'a'.repeat(48),
    JWT_REFRESH_SECRET: 'b'.repeat(48),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    OPENAI_API_KEY: 'sk-test-staging-template',
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'mailer',
    SMTP_PASS: 'mailer-password',
    RAZORPAY_KEY_ID: 'rzp_test_template',
    RAZORPAY_KEY_SECRET: 'razorpay-test-secret',
    RAZORPAY_WEBHOOK_SECRET: 'razorpay-webhook-secret',
    BILLING_SELLER_NAME: 'Example Pvt Ltd',
    BILLING_SELLER_ADDRESS: '1 Road, Jaipur',
    BILLING_SELLER_GSTIN: makeGstin('08'),
    BILLING_SELLER_STATE_CODE: '08',
  };
  const env: NodeJS.ProcessEnv = {};
  for (const [key, raw] of entries()) {
    const value = raw
      .replaceAll('<app-host>', 'staging.example.com')
      .replaceAll('<secret>', 'pw')
      .replaceAll('<elastic ip>', '203.0.113.10')
      .replaceAll('<domain>', 'example.com');
    env[key] = secrets[key] ?? value;
  }
  return { ...env, ...over };
};

describe('deploy/staging/env.example (Phase 13)', () => {
  it('Docker build-info defaults are accepted by the runtime env parser', () => {
    const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    const defaults = Object.fromEntries(
      [...dockerfile.matchAll(/^ARG (GIT_SHA|BUILT_AT)=(.*)$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(() => loadEnv(defaults)).not.toThrow();
  });

  it('names only variables the API knows (no typos)', () => {
    const unknown = entries()
      .map(([k]) => k)
      .filter((k) => !(ENV_KEYS as readonly string[]).includes(k));
    expect(unknown).toEqual([]);
  });

  it('every secret is left empty in the template', () => {
    const map = new Map(entries());
    for (const key of [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'ENCRYPTION_KEY',
      'OPENAI_API_KEY',
      'META_APP_SECRET',
      'META_WEBHOOK_VERIFY_TOKEN',
      'META_SYSTEM_USER_TOKEN',
      'SMTP_PASS',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ])
      expect(map.get(key), key).toBe('');
  });

  it('filled in, it passes every production check (before GATE B: WhatsApp off)', () => {
    const env = loadEnv(filled());
    expect(env).toMatchObject({
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      TRUST_PROXY: 1,
      WHATSAPP_ENABLED: false,
      PAYMENT_PROVIDER: 'razorpay',
      AI_PROVIDER: 'openai',
      EMAIL_DRIVER: 'smtp',
      META_GRAPH_VERSION: 'v26.0',
      BILLING_INVOICE_PREFIX: 'STG',
    });
  });

  it('after GATE B (Meta values filled) WhatsApp is on with the real provider', () => {
    const env = loadEnv(
      filled({
        WHATSAPP_ENABLED: 'true',
        META_APP_ID: '1234567890123456',
        META_APP_SECRET: 'm'.repeat(32),
        META_ES_CONFIG_ID: '987654321098765',
        META_WEBHOOK_VERIFY_TOKEN: 'v'.repeat(24),
      }),
    );
    expect(env).toMatchObject({
      WHATSAPP_ENABLED: true,
      META_PROVIDER: 'meta',
      WA_MEDIA_PUBLIC_IP: '203.0.113.10',
    });
  });
});
