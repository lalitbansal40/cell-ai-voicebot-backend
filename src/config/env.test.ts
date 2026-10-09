import { describe, expect, it } from 'vitest';

import { makeGstin } from '../shared/gstin';

import { EnvValidationError, loadEnv } from './env';

const PROD_SECRET_A = 'test-access-secret-0123456789abcdefXYZ';
const PROD_SECRET_B = 'test-refresh-secret-0123456789abcdefXYZ';
const PROD_KEY = Buffer.alloc(32, 7).toString('base64');

const validProduction = {
  NODE_ENV: 'production',
  APP_URL: 'https://api.example.com',
  FRONTEND_URL: 'https://app.example.com',
  CORS_ORIGINS: 'https://app.example.com',
  MONGODB_URI: 'mongodb://db.internal:27017/cav?replicaSet=rs0',
  REDIS_URL: 'redis://cache.internal:6379',
  JWT_ACCESS_SECRET: PROD_SECRET_A,
  JWT_REFRESH_SECRET: PROD_SECRET_B,
  ENCRYPTION_KEY: PROD_KEY,
  SMTP_HOST: 'smtp.example.com',
  MAIL_FROM: 'Cell AI Voicebot <no-reply@example.com>',
  RAZORPAY_KEY_ID: 'rzp_test_example',
  RAZORPAY_KEY_SECRET: 'test-razorpay-key-secret',
  RAZORPAY_WEBHOOK_SECRET: 'test-razorpay-webhook-secret',
  BILLING_SELLER_NAME: 'Example Voice Pvt Ltd',
  BILLING_SELLER_ADDRESS: '1 Example Road, Jaipur, Rajasthan 302001',
  BILLING_SELLER_STATE_CODE: '08',
  BILLING_SELLER_GSTIN: makeGstin('08'),
};

const issuesOf = (source: NodeJS.ProcessEnv) => {
  try {
    loadEnv(source);
  } catch (err) {
    expect(err).toBeInstanceOf(EnvValidationError);
    return err as EnvValidationError;
  }
  throw new Error('expected EnvValidationError');
};

describe('loadEnv — development defaults', () => {
  const env = loadEnv({});

  it('defaults to development on port 5100 with local URLs', () => {
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(5100);
    expect(env.APP_URL).toBe('http://localhost:5100');
    expect(env.FRONTEND_URL).toBe('http://localhost:3100');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3100']);
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.TRUST_PROXY).toBe(false);
  });

  it('points at the local Docker infra', () => {
    expect(env.MONGODB_URI).toBe('mongodb://127.0.0.1:27018/cell_ai_voicebot?replicaSet=rs0');
    expect(env.REDIS_URL).toBe('redis://127.0.0.1:6380');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(env)).toBe(true);
    expect(Object.isFrozen(env.CORS_ORIGINS)).toBe(true);
  });

  it('uses silent logging in test', () => {
    expect(loadEnv({ NODE_ENV: 'test' }).LOG_LEVEL).toBe('silent');
  });
});

describe('loadEnv — parsing', () => {
  it('coerces numbers', () => {
    const env = loadEnv({ PORT: '6000', SMTP_PORT: '465', SIP_PORT: '5080' });
    expect(env.PORT).toBe(6000);
    expect(env.SMTP_PORT).toBe(465);
    expect(env.SIP_PORT).toBe(5080);
  });

  it('parses CORS lists (trim, trailing slash, empties)', () => {
    const env = loadEnv({ CORS_ORIGINS: ' http://a.test/ , ,http://b.test ' });
    expect(env.CORS_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('treats empty strings as unset', () => {
    const env = loadEnv({ PORT: '', LOG_LEVEL: '  ', OPENAI_API_KEY: '' });
    expect(env.PORT).toBe(5100);
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it.each([
    ['true', true],
    ['false', false],
    ['2', 2],
    ['loopback', 'loopback'],
  ])('parses TRUST_PROXY=%s', (value, expected) => {
    expect(loadEnv({ TRUST_PROXY: value }).TRUST_PROXY).toBe(expected);
  });

  it('rejects an invalid port, log level, URL and duration', () => {
    const err = issuesOf({
      PORT: '99999',
      LOG_LEVEL: 'loud',
      APP_URL: 'not a url',
      JWT_ACCESS_TTL: 'soon',
    });
    expect(err.issues.map((i) => i.variable).sort()).toEqual([
      'APP_URL',
      'JWT_ACCESS_TTL',
      'LOG_LEVEL',
      'PORT',
    ]);
  });

  it('rejects a non-mongodb URI', () => {
    expect(issuesOf({ MONGODB_URI: 'postgres://x' }).issues[0]?.variable).toBe('MONGODB_URI');
  });

  it('rejects a CORS entry that is not a URL', () => {
    expect(issuesOf({ CORS_ORIGINS: 'http://ok.test,nope' }).issues[0]?.variable).toBe(
      'CORS_ORIGINS',
    );
  });
});

describe('loadEnv — production rules', () => {
  it('accepts a complete production env', () => {
    const env = loadEnv(validProduction);
    expect(env.NODE_ENV).toBe('production');
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('lists every missing production variable by name', () => {
    const err = issuesOf({ NODE_ENV: 'production' });
    expect(err.issues.map((i) => i.variable).sort()).toEqual(
      [
        'APP_URL',
        'CORS_ORIGINS',
        'EMAIL_DRIVER',
        'ENCRYPTION_KEY',
        'FRONTEND_URL',
        'JWT_ACCESS_SECRET',
        'JWT_REFRESH_SECRET',
        'MONGODB_URI',
        'REDIS_URL',
        'RAZORPAY_KEY_ID',
        'RAZORPAY_KEY_SECRET',
        'RAZORPAY_WEBHOOK_SECRET',
        'BILLING_SELLER_STATE_CODE',
        'BILLING_SELLER_NAME',
        'BILLING_SELLER_ADDRESS',
        'BILLING_SELLER_GSTIN',
      ].sort(),
    );
  });

  it('rejects placeholder and short JWT secrets', () => {
    const err = issuesOf({
      ...validProduction,
      JWT_ACCESS_SECRET: 'change-me-change-me-change-me-change-me',
      JWT_REFRESH_SECRET: 'short',
    });
    expect(err.issues.map((i) => i.variable).sort()).toEqual([
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
    ]);
  });

  it('requires ENCRYPTION_KEY to be 32 bytes of base64', () => {
    const err = issuesOf({
      ...validProduction,
      ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
    });
    expect(err.issues[0]?.variable).toBe('ENCRYPTION_KEY');
  });

  it('never includes secret values in the error message', () => {
    const leaked = 'super-secret-value-that-must-not-leak';
    const err = issuesOf({
      ...validProduction,
      JWT_ACCESS_SECRET: leaked.slice(0, 10),
      ENCRYPTION_KEY: leaked,
    });
    expect(err.message).not.toContain(leaked);
    expect(err.message).not.toContain(leaked.slice(0, 10));
    expect(err.message).toContain('JWT_ACCESS_SECRET');
  });
});

describe('loadEnv — workers', () => {
  it('enables workers by default', () => expect(loadEnv({}).WORKERS_ENABLED).toBe(true));
  it('parses false', () =>
    expect(loadEnv({ WORKERS_ENABLED: 'false' }).WORKERS_ENABLED).toBe(false));
  it('rejects other values', () =>
    expect(issuesOf({ WORKERS_ENABLED: 'yes' }).issues[0]?.variable).toBe('WORKERS_ENABLED'));
});

describe('loadEnv — storage', () => {
  it('requires S3 settings when STORAGE_DRIVER=s3', () => {
    const err = issuesOf({ STORAGE_DRIVER: 's3', S3_BUCKET: 'bucket' });
    expect(err.issues.map((i) => i.variable).sort()).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'S3_REGION',
    ]);
  });

  it('defaults to local storage', () => {
    expect(loadEnv({}).STORAGE_DRIVER).toBe('local');
  });
});

describe('loadEnv — email', () => {
  it('uses the log driver without SMTP_HOST and a dev MAIL_FROM', () => {
    const env = loadEnv({});
    expect(env.EMAIL_DRIVER).toBe('log');
    expect(env.MAIL_FROM).toBe('Cell AI Voicebot <no-reply@localhost>');
    expect(env.SMTP_SECURE).toBe(false);
  });

  it('uses the smtp driver when SMTP_HOST is set', () => {
    expect(loadEnv({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' }).EMAIL_DRIVER).toBe('smtp');
  });

  it('honours an explicit log driver even with SMTP_HOST', () => {
    expect(loadEnv({ SMTP_HOST: '127.0.0.1', EMAIL_DRIVER: 'log' }).EMAIL_DRIVER).toBe('log');
  });

  it('requires SMTP_HOST for an explicit smtp driver', () => {
    expect(issuesOf({ EMAIL_DRIVER: 'smtp' }).issues[0]?.variable).toBe('SMTP_HOST');
  });

  it('derives SMTP_SECURE from the port unless set', () => {
    expect(loadEnv({ SMTP_PORT: '465' }).SMTP_SECURE).toBe(true);
    expect(loadEnv({ SMTP_PORT: '587' }).SMTP_SECURE).toBe(false);
    expect(loadEnv({ SMTP_PORT: '587', SMTP_SECURE: 'true' }).SMTP_SECURE).toBe(true);
    expect(loadEnv({ SMTP_PORT: '465', SMTP_SECURE: 'false' }).SMTP_SECURE).toBe(false);
    expect(issuesOf({ SMTP_SECURE: 'yes' }).issues[0]?.variable).toBe('SMTP_SECURE');
  });

  it('requires SMTP_USER and SMTP_PASS together', () => {
    expect(issuesOf({ SMTP_USER: 'smtp-user' }).issues[0]?.reason).toContain('together');
    expect(issuesOf({ SMTP_PASS: 'smtp-pass' }).issues[0]?.variable).toBe('SMTP_USER');
    expect(loadEnv({ SMTP_USER: 'smtp-user', SMTP_PASS: 'smtp-pass' }).SMTP_USER).toBe('smtp-user');
  });

  it('rejects the log driver in production', () => {
    const { SMTP_HOST: _host, ...noSmtp } = validProduction;
    expect(issuesOf(noSmtp).issues.map((i) => i.variable)).toEqual(['EMAIL_DRIVER']);
    expect(
      issuesOf({ ...validProduction, EMAIL_DRIVER: 'log' }).issues.map((i) => i.variable),
    ).toEqual(['EMAIL_DRIVER']);
  });

  it('requires MAIL_FROM for smtp in production', () => {
    const { MAIL_FROM: _from, ...noFrom } = validProduction;
    expect(issuesOf(noFrom).issues.map((i) => i.variable)).toEqual(['MAIL_FROM']);
  });
});

describe('loadEnv — API docs', () => {
  it('enables Swagger UI outside production by default', () => {
    expect(loadEnv({}).API_DOCS_ENABLED).toBe(true);
    expect(loadEnv({ NODE_ENV: 'test' }).API_DOCS_ENABLED).toBe(true);
  });

  it('disables it in production unless explicitly enabled', () => {
    expect(loadEnv(validProduction).API_DOCS_ENABLED).toBe(false);
    expect(loadEnv({ ...validProduction, API_DOCS_ENABLED: 'true' }).API_DOCS_ENABLED).toBe(true);
    expect(loadEnv({ API_DOCS_ENABLED: 'false' }).API_DOCS_ENABLED).toBe(false);
    expect(issuesOf({ API_DOCS_ENABLED: 'on' }).issues[0]?.variable).toBe('API_DOCS_ENABLED');
  });
});

describe('loadEnv — auth extras', () => {
  it('keeps AUTH_COOKIE_DOMAIN and SEED_PASSWORD optional', () => {
    const env = loadEnv({});
    expect(env.AUTH_COOKIE_DOMAIN).toBeUndefined();
    expect(env.SEED_PASSWORD).toBeUndefined();
    expect(loadEnv({ AUTH_COOKIE_DOMAIN: '.example.com' }).AUTH_COOKIE_DOMAIN).toBe('.example.com');
  });
});

describe('loadEnv — payments & billing', () => {
  it('uses the fake provider and sample seller outside production', () => {
    const env = loadEnv({});
    expect(env.PAYMENT_PROVIDER).toBe('fake');
    expect(env.FAKE_PAYMENT_SECRET).toBe('dev-fake-payment-secret');
    expect(env.BILLING_SELLER_STATE_CODE).toBe('08');
    expect(env.BILLING_SELLER_NAME).toMatch(/sample/i);
    expect(env.BILLING_SAC_CODE).toBe('998319');
    expect(env.BILLING_INVOICE_PREFIX).toBe('CAV');
    expect(env.BILLING_SIMULATOR_ENABLED).toBe(true);
    expect(loadEnv({ BILLING_SIMULATOR_ENABLED: 'false' }).BILLING_SIMULATOR_ENABLED).toBe(false);
    expect(loadEnv({ FAKE_PAYMENT_SECRET: 'x' }).FAKE_PAYMENT_SECRET).toBe('x');
  });

  it('defaults to razorpay in production, simulator off, no fake secret', () => {
    const env = loadEnv(validProduction);
    expect(env.PAYMENT_PROVIDER).toBe('razorpay');
    expect(env.FAKE_PAYMENT_SECRET).toBeUndefined();
    expect(env.BILLING_SIMULATOR_ENABLED).toBe(false);
  });

  it('refuses the fake provider and its secret in production', () => {
    const err = issuesOf({
      ...validProduction,
      PAYMENT_PROVIDER: 'fake',
      FAKE_PAYMENT_SECRET: 'x',
    });
    expect(err.issues.map((i) => i.variable).sort()).toEqual(
      ['FAKE_PAYMENT_SECRET', 'PAYMENT_PROVIDER'].sort(),
    );
  });

  it('needs the three razorpay keys when razorpay is chosen', () => {
    const err = issuesOf({ PAYMENT_PROVIDER: 'razorpay' });
    expect(err.issues.map((i) => i.variable)).toEqual([
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
    ]);
  });

  it('validates the seller state, GSTIN, SAC and prefix', () => {
    expect(issuesOf({ BILLING_SELLER_STATE_CODE: '99' }).issues[0]?.variable).toBe(
      'BILLING_SELLER_STATE_CODE',
    );
    expect(issuesOf({ BILLING_SELLER_GSTIN: makeGstin('27') }).issues[0]?.reason).toMatch(/GSTIN/);
    expect(
      loadEnv({ BILLING_SELLER_STATE_CODE: '27', BILLING_SELLER_GSTIN: makeGstin('27') })
        .BILLING_SELLER_STATE_CODE,
    ).toBe('27');
    expect(issuesOf({ BILLING_SAC_CODE: '12' }).issues[0]?.variable).toBe('BILLING_SAC_CODE');
    expect(issuesOf({ BILLING_INVOICE_PREFIX: 'cavx' }).issues[0]?.variable).toBe(
      'BILLING_INVOICE_PREFIX',
    );
  });
});
