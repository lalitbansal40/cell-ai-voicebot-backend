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
  OPENAI_API_KEY: 'test-openai-key-not-real',
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
        'OPENAI_API_KEY',
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

describe('loadEnv — AI (Phase 5)', () => {
  it('uses the fake provider, mock APIs and private hosts outside production without a key', () => {
    const env = loadEnv({});
    expect(env.AI_PROVIDER).toBe('fake');
    expect(env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(env.OPENAI_TEXT_MODEL).toBe('gpt-4.1-mini');
    expect(env.OPENAI_EMBEDDING_MODEL).toBe('text-embedding-3-small');
    expect(env.AI_TEXT_MODELS).toEqual(['gpt-4.1-mini']);
    expect(env.AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS).toBe(true);
    expect(env.MOCK_APIS_ENABLED).toBe(true);
  });

  it('defaults to openai when a key is set, and needs the key for openai', () => {
    expect(loadEnv({ OPENAI_API_KEY: 'k' }).AI_PROVIDER).toBe('openai');
    expect(loadEnv({ OPENAI_API_KEY: 'k', AI_PROVIDER: 'fake' }).AI_PROVIDER).toBe('fake');
    expect(issuesOf({ AI_PROVIDER: 'openai' }).issues).toContainEqual({
      variable: 'OPENAI_API_KEY',
      reason: 'required when AI_PROVIDER=openai',
    });
  });

  it('validates the model list', () => {
    expect(loadEnv({ AI_TEXT_MODELS: 'gpt-4.1-mini, gpt-4.1' }).AI_TEXT_MODELS).toEqual([
      'gpt-4.1-mini',
      'gpt-4.1',
    ]);
    expect(issuesOf({ AI_TEXT_MODELS: 'gpt-4.1' }).issues.map((i) => i.variable)).toContain(
      'AI_TEXT_MODELS',
    );
    expect(
      issuesOf({ AI_TEXT_MODELS: 'gpt-4.1-mini,Bad Model' }).issues.map((i) => i.variable),
    ).toContain('AI_TEXT_MODELS');
    expect(issuesOf({ OPENAI_TEXT_MODEL: 'Bad Model' }).issues.map((i) => i.variable)).toContain(
      'OPENAI_TEXT_MODEL',
    );
  });

  it('turns mock APIs and private hosts off in production and refuses them', () => {
    const env = loadEnv(validProduction);
    expect(env.AI_PROVIDER).toBe('openai');
    expect(env.AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS).toBe(false);
    expect(env.MOCK_APIS_ENABLED).toBe(false);
    const issues = issuesOf({
      ...validProduction,
      AI_PROVIDER: 'fake',
      AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'true',
      MOCK_APIS_ENABLED: 'true',
    }).issues.map((i) => i.variable);
    expect(issues).toEqual(
      expect.arrayContaining([
        'AI_PROVIDER',
        'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS',
        'MOCK_APIS_ENABLED',
      ]),
    );
    const { OPENAI_API_KEY: _key, ...noKey } = validProduction;
    expect(issuesOf(noKey).issues.map((i) => i.variable)).toContain('OPENAI_API_KEY');
  });
});

describe('loadEnv — voice calls', () => {
  it('defaults: fake voice, realtime pipeline, text input on, models, retention, tmp dir', () => {
    const env = loadEnv({});
    expect(env.VOICE_PROVIDER).toBe('fake');
    expect(env.VOICE_PIPELINE).toBe('realtime');
    expect(env.VOICE_TEXT_INPUT_ENABLED).toBe(true);
    expect(env.OPENAI_REALTIME_MODEL).toBe('gpt-realtime-2.1-mini');
    expect(env.OPENAI_TTS_MODEL).toBe('gpt-4o-mini-tts');
    expect(env.OPENAI_TRANSCRIBE_MODEL).toBe('gpt-4o-mini-transcribe');
    expect(env.CALL_RETENTION_DAYS).toBe(180);
    expect(env.CALL_RECORDING_TMP_DIR).toMatch(/cav-rec$/);
  });

  it('follows AI_PROVIDER and parses explicit values', () => {
    expect(loadEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }).VOICE_PROVIDER).toBe('openai');
    const env = loadEnv({
      VOICE_PROVIDER: 'fake',
      VOICE_PIPELINE: 'chat',
      VOICE_TEXT_INPUT_ENABLED: 'false',
      OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1',
      CALL_RETENTION_DAYS: '30',
      CALL_RECORDING_TMP_DIR: '/tmp/rec',
    });
    expect(env).toMatchObject({
      VOICE_PROVIDER: 'fake',
      VOICE_PIPELINE: 'chat',
      VOICE_TEXT_INPUT_ENABLED: false,
      OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1',
      CALL_RETENTION_DAYS: 30,
      CALL_RECORDING_TMP_DIR: '/tmp/rec',
    });
  });

  it('openai voice needs a key; bad model ids and retention are refused', () => {
    expect(issuesOf({ VOICE_PROVIDER: 'openai' }).issues).toContainEqual(
      expect.objectContaining({ variable: 'OPENAI_API_KEY' }),
    );
    expect(issuesOf({ OPENAI_REALTIME_MODEL: 'Bad Model' }).issues).toContainEqual(
      expect.objectContaining({ variable: 'OPENAI_REALTIME_MODEL' }),
    );
    expect(issuesOf({ CALL_RETENTION_DAYS: '3' }).issues[0]?.variable).toBe('CALL_RETENTION_DAYS');
    expect(issuesOf({ VOICE_PIPELINE: 'x' }).issues[0]?.variable).toBe('VOICE_PIPELINE');
  });

  it('production: openai voice only and no typed text input', () => {
    expect(loadEnv(validProduction).VOICE_TEXT_INPUT_ENABLED).toBe(false);
    const err = issuesOf({
      ...validProduction,
      VOICE_PROVIDER: 'fake',
      VOICE_TEXT_INPUT_ENABLED: 'true',
    });
    expect(err.issues.map((i) => i.variable).sort()).toEqual([
      'VOICE_PROVIDER',
      'VOICE_TEXT_INPUT_ENABLED',
    ]);
  });
});

describe('loadEnv — campaigns', () => {
  it('defaults: dry-run telephony, max speed 50, campaigns on', () => {
    const env = loadEnv({});
    expect(env.TELEPHONY_PROVIDER).toBe('dryrun');
    expect(env.DRY_RUN_MAX_SPEED).toBe(50);
    expect(env.CAMPAIGNS_ENABLED).toBe(true);
  });

  it('parses explicit values; sip is not available yet; speed 1–100', () => {
    expect(
      loadEnv({ DRY_RUN_MAX_SPEED: '5', CAMPAIGNS_ENABLED: 'false', TELEPHONY_PROVIDER: 'dryrun' }),
    ).toMatchObject({
      DRY_RUN_MAX_SPEED: 5,
      CAMPAIGNS_ENABLED: false,
      TELEPHONY_PROVIDER: 'dryrun',
    });
    expect(issuesOf({ TELEPHONY_PROVIDER: 'sip' }).issues[0]?.variable).toBe('TELEPHONY_PROVIDER');
    expect(issuesOf({ DRY_RUN_MAX_SPEED: '0' }).issues[0]?.variable).toBe('DRY_RUN_MAX_SPEED');
    expect(issuesOf({ DRY_RUN_MAX_SPEED: '101' }).issues[0]?.variable).toBe('DRY_RUN_MAX_SPEED');
    expect(issuesOf({ CAMPAIGNS_ENABLED: 'yes' }).issues[0]?.variable).toBe('CAMPAIGNS_ENABLED');
  });

  it('production: max speed defaults to 20 and may not exceed it', () => {
    expect(loadEnv(validProduction).DRY_RUN_MAX_SPEED).toBe(20);
    expect(loadEnv({ ...validProduction, DRY_RUN_MAX_SPEED: '10' }).DRY_RUN_MAX_SPEED).toBe(10);
    expect(
      issuesOf({ ...validProduction, DRY_RUN_MAX_SPEED: '50' }).issues.map((i) => i.variable),
    ).toEqual(['DRY_RUN_MAX_SPEED']);
  });
});

describe('loadEnv — WhatsApp (Phase 9)', () => {
  const META = {
    META_PROVIDER: 'meta',
    META_APP_ID: '1234567890',
    META_APP_SECRET: 'test-meta-app-secret-0123456789abcdef',
    META_ES_CONFIG_ID: '987654321',
    META_WEBHOOK_VERIFY_TOKEN: 'test-meta-verify-token-0123456789',
    // Phase 12: call media needs the public IP with the meta provider
    WA_MEDIA_PUBLIC_IP: '203.0.113.10',
  };

  it('defaults: on outside production with the fake provider, dev token and fake secret', () => {
    const env = loadEnv({});
    expect(env.WHATSAPP_ENABLED).toBe(true);
    expect(env.META_PROVIDER).toBe('fake');
    expect(env.META_WEBHOOK_VERIFY_TOKEN).toBe('dev-meta-verify-token');
    expect(env.FAKE_META_APP_SECRET).toBe('dev-fake-meta-app-secret');
    expect(env.META_GRAPH_VERSION).toBe('v23.0');
    expect(env.META_GRAPH_BASE_URL).toBe('https://graph.facebook.com');
    expect(loadEnv({ FAKE_META_APP_SECRET: 'x' }).FAKE_META_APP_SECRET).toBe('x');
    expect(loadEnv({ WHATSAPP_ENABLED: 'false' }).WHATSAPP_ENABLED).toBe(false);
  });

  it('the meta provider needs app id, secret, config id and verify token (never echoing values)', () => {
    const err = issuesOf({ META_PROVIDER: 'meta' });
    expect(err.issues.map((i) => i.variable)).toEqual(
      expect.arrayContaining([
        'META_APP_ID',
        'META_APP_SECRET',
        'META_ES_CONFIG_ID',
        'META_WEBHOOK_VERIFY_TOKEN',
      ]),
    );
    const weak = issuesOf({
      ...META,
      META_APP_SECRET: 'change-me-0123456789abcdef0123456789',
      META_WEBHOOK_VERIFY_TOKEN: 'short',
    });
    expect(weak.issues.map((i) => i.variable)).toEqual([
      'META_APP_SECRET',
      'META_WEBHOOK_VERIFY_TOKEN',
    ]);
    expect(weak.message).not.toContain('change-me-0123');
    const env = loadEnv(META);
    expect(env.META_PROVIDER).toBe('meta');
    expect(env.FAKE_META_APP_SECRET).toBeUndefined();
    expect(env.META_WEBHOOK_VERIFY_TOKEN).toBe(META.META_WEBHOOK_VERIFY_TOKEN);
    // disabled: nothing is required
    expect(loadEnv({ META_PROVIDER: 'meta', WHATSAPP_ENABLED: 'false' }).WHATSAPP_ENABLED).toBe(
      false,
    );
  });

  it('validates formats', () => {
    expect(issuesOf({ META_APP_ID: 'abc' }).issues[0]?.variable).toBe('META_APP_ID');
    expect(issuesOf({ META_ES_CONFIG_ID: '12a' }).issues[0]?.variable).toBe('META_ES_CONFIG_ID');
    expect(issuesOf({ META_CREDIT_LINE_ID: 'x1' }).issues[0]?.variable).toBe('META_CREDIT_LINE_ID');
    expect(issuesOf({ META_GRAPH_VERSION: '23' }).issues[0]?.variable).toBe('META_GRAPH_VERSION');
    expect(issuesOf({ META_PROVIDER: 'other' }).issues[0]?.variable).toBe('META_PROVIDER');
    expect(issuesOf({ WHATSAPP_ENABLED: 'yes' }).issues[0]?.variable).toBe('WHATSAPP_ENABLED');
  });

  it('production: off without Meta config, on with it, meta only, default Graph URL, no fake secret', () => {
    expect(loadEnv(validProduction).WHATSAPP_ENABLED).toBe(false);
    const on = loadEnv({ ...validProduction, ...META });
    expect(on.WHATSAPP_ENABLED).toBe(true);
    expect(on.META_PROVIDER).toBe('meta');
    expect(
      issuesOf({ ...validProduction, WHATSAPP_ENABLED: 'true' }).issues.map((i) => i.variable),
    ).toEqual(expect.arrayContaining(['META_APP_ID', 'META_APP_SECRET']));
    expect(
      issuesOf({ ...validProduction, ...META, META_PROVIDER: 'fake' }).issues.map(
        (i) => i.variable,
      ),
    ).toEqual(['META_PROVIDER']);
    expect(
      issuesOf({
        ...validProduction,
        ...META,
        META_GRAPH_BASE_URL: 'http://127.0.0.1:9',
      }).issues.map((i) => i.variable),
    ).toEqual(['META_GRAPH_BASE_URL']);
    expect(
      issuesOf({ ...validProduction, FAKE_META_APP_SECRET: 'x' }).issues.map((i) => i.variable),
    ).toEqual(['FAKE_META_APP_SECRET']);
  });
});

describe('loadEnv — WhatsApp inbox (Phase 10)', () => {
  it('retention: 90 days by default, 0 keeps forever, otherwise at least 30', () => {
    expect(loadEnv({}).INBOX_RETENTION_DAYS).toBe(90);
    expect(loadEnv({ INBOX_RETENTION_DAYS: '0' }).INBOX_RETENTION_DAYS).toBe(0);
    expect(loadEnv({ INBOX_RETENTION_DAYS: '30' }).INBOX_RETENTION_DAYS).toBe(30);
    for (const bad of ['29', '1', '-5', 'ninety', '1.5']) {
      expect(issuesOf({ INBOX_RETENTION_DAYS: bad }).issues.map((i) => i.variable)).toEqual([
        'INBOX_RETENTION_DAYS',
      ]);
    }
    expect(loadEnv({ ...validProduction, INBOX_RETENTION_DAYS: '90' }).INBOX_RETENTION_DAYS).toBe(
      90,
    );
    expect(
      issuesOf({ ...validProduction, INBOX_RETENTION_DAYS: '7' }).issues.map((i) => i.variable),
    ).toEqual(['INBOX_RETENTION_DAYS']);
  });

  it('fake status delays: on in development, off in tests, parsed, never in production', () => {
    expect(loadEnv({}).FAKE_META_STATUS_DELAYS_MS).toEqual([500, 1500, 3000]);
    expect(loadEnv({ NODE_ENV: 'test' }).FAKE_META_STATUS_DELAYS_MS).toBeNull();
    expect(
      loadEnv({ NODE_ENV: 'test', FAKE_META_STATUS_DELAYS_MS: '200,500,800' })
        .FAKE_META_STATUS_DELAYS_MS,
    ).toEqual([200, 500, 800]);
    expect(loadEnv({ FAKE_META_STATUS_DELAYS_MS: 'OFF' }).FAKE_META_STATUS_DELAYS_MS).toBeNull();
    expect(loadEnv({ FAKE_META_STATUS_DELAYS_MS: '0, 0, 0' }).FAKE_META_STATUS_DELAYS_MS).toEqual([
      0, 0, 0,
    ]);
    for (const bad of ['1,2', '1,2,3,4', 'a,b,c', '1,-2,3', '1,2,60001', 'soon']) {
      expect(issuesOf({ FAKE_META_STATUS_DELAYS_MS: bad }).issues.map((i) => i.variable)).toEqual([
        'FAKE_META_STATUS_DELAYS_MS',
      ]);
    }
    // the real provider never fakes statuses
    expect(
      loadEnv({
        META_PROVIDER: 'meta',
        WHATSAPP_ENABLED: 'false',
        FAKE_META_STATUS_DELAYS_MS: '1,2,3',
      }).FAKE_META_STATUS_DELAYS_MS,
    ).toBeNull();
    expect(loadEnv(validProduction).FAKE_META_STATUS_DELAYS_MS).toBeNull();
    expect(
      issuesOf({ ...validProduction, FAKE_META_STATUS_DELAYS_MS: '1,2,3' }).issues.map(
        (i) => i.variable,
      ),
    ).toEqual(['FAKE_META_STATUS_DELAYS_MS']);
  });

  it('fake template review delay: 3 s in development, off in tests, never in production', () => {
    expect(loadEnv({}).FAKE_META_TEMPLATE_REVIEW_MS).toBe(3000);
    expect(loadEnv({ NODE_ENV: 'test' }).FAKE_META_TEMPLATE_REVIEW_MS).toBeNull();
    expect(
      loadEnv({ NODE_ENV: 'test', FAKE_META_TEMPLATE_REVIEW_MS: '250' })
        .FAKE_META_TEMPLATE_REVIEW_MS,
    ).toBe(250);
    expect(
      loadEnv({ FAKE_META_TEMPLATE_REVIEW_MS: 'OFF' }).FAKE_META_TEMPLATE_REVIEW_MS,
    ).toBeNull();
    expect(loadEnv({ FAKE_META_TEMPLATE_REVIEW_MS: '0' }).FAKE_META_TEMPLATE_REVIEW_MS).toBe(0);
    for (const bad of ['-1', 'soon', '600001', '1.5']) {
      expect(issuesOf({ FAKE_META_TEMPLATE_REVIEW_MS: bad }).issues.map((i) => i.variable)).toEqual(
        ['FAKE_META_TEMPLATE_REVIEW_MS'],
      );
    }
    expect(
      loadEnv({
        META_PROVIDER: 'meta',
        WHATSAPP_ENABLED: 'false',
        FAKE_META_TEMPLATE_REVIEW_MS: '10',
      }).FAKE_META_TEMPLATE_REVIEW_MS,
    ).toBeNull();
    expect(loadEnv(validProduction).FAKE_META_TEMPLATE_REVIEW_MS).toBeNull();
    expect(
      issuesOf({ ...validProduction, FAKE_META_TEMPLATE_REVIEW_MS: '10' }).issues.map(
        (i) => i.variable,
      ),
    ).toEqual(['FAKE_META_TEMPLATE_REVIEW_MS']);
  });
});

describe('loadEnv — WhatsApp calling (Phase 12)', () => {
  it('defaults: media on with WhatsApp, ports 40000–40999, 50 calls, Google STUN outside tests', () => {
    const env = loadEnv({});
    expect(env.WA_MEDIA_ENABLED).toBe(true);
    expect(env.WA_MEDIA_PUBLIC_IP).toBeUndefined();
    expect([env.WA_MEDIA_PORT_MIN, env.WA_MEDIA_PORT_MAX]).toEqual([40_000, 40_999]);
    expect(env.WA_MEDIA_MAX_CALLS).toBe(50);
    expect(env.WA_STUN_URLS).toEqual(['stun:stun.l.google.com:19302']);
    expect(loadEnv({ NODE_ENV: 'test' }).WA_STUN_URLS).toEqual([]);
    expect(loadEnv({ WA_STUN_URLS: 'off' }).WA_STUN_URLS).toEqual([]);
    expect(
      loadEnv({ WA_STUN_URLS: 'stun:a.example.com:3478, stun:b.example.com:19302' }).WA_STUN_URLS,
    ).toEqual(['stun:a.example.com:3478', 'stun:b.example.com:19302']);
    expect(loadEnv({ WHATSAPP_ENABLED: 'false' }).WA_MEDIA_ENABLED).toBe(false);
    expect(loadEnv({ WHATSAPP_ENABLED: 'false', WA_MEDIA_ENABLED: 'true' }).WA_MEDIA_ENABLED).toBe(
      false,
    );
    expect(loadEnv({ WA_MEDIA_ENABLED: 'false' }).WA_MEDIA_ENABLED).toBe(false);
    expect(loadEnv({ WA_MEDIA_PUBLIC_IP: '203.0.113.10' }).WA_MEDIA_PUBLIC_IP).toBe('203.0.113.10');
  });

  it('rejects bad values (never echoing them)', () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ WA_MEDIA_PUBLIC_IP: 'not-an-ip' }, 'WA_MEDIA_PUBLIC_IP'],
      [{ WA_MEDIA_PUBLIC_IP: '::1' }, 'WA_MEDIA_PUBLIC_IP'],
      [{ WA_MEDIA_PORT_MIN: '40000', WA_MEDIA_PORT_MAX: '40050' }, 'WA_MEDIA_PORT_MAX'],
      [{ WA_MEDIA_PORT_MIN: '80' }, 'WA_MEDIA_PORT_MIN'],
      [{ WA_STUN_URLS: 'turn:x.example.com:3478' }, 'WA_STUN_URLS'],
      [{ WA_STUN_URLS: 'stun:x.example.com' }, 'WA_STUN_URLS'],
      [{ WA_MEDIA_MAX_CALLS: '0' }, 'WA_MEDIA_MAX_CALLS'],
      [{ WA_MEDIA_ENABLED: 'yes' }, 'WA_MEDIA_ENABLED'],
    ];
    for (const [source, variable] of cases) {
      const err = issuesOf(source);
      expect(err.issues.map((i) => i.variable)).toEqual([variable]);
      expect(err.message).not.toContain('not-an-ip');
    }
  });

  it('the meta provider needs the public media IP (unless media is off)', () => {
    const META = {
      META_PROVIDER: 'meta',
      META_APP_ID: '1234567890',
      META_APP_SECRET: 'test-meta-app-secret-0123456789abcdef',
      META_ES_CONFIG_ID: '987654321',
      META_WEBHOOK_VERIFY_TOKEN: 'test-meta-verify-token-0123456789',
    };
    expect(issuesOf(META).issues.map((i) => i.variable)).toEqual(['WA_MEDIA_PUBLIC_IP']);
    expect(loadEnv({ ...META, WA_MEDIA_PUBLIC_IP: '203.0.113.10' }).WA_MEDIA_ENABLED).toBe(true);
    expect(loadEnv({ ...META, WA_MEDIA_ENABLED: 'false' }).WA_MEDIA_ENABLED).toBe(false);
  });

  it('fake call delays: 100,200,800 in development, off in tests, never in production', () => {
    expect(loadEnv({}).FAKE_META_CALL_DELAYS_MS).toEqual([100, 200, 800]);
    expect(loadEnv({ NODE_ENV: 'test' }).FAKE_META_CALL_DELAYS_MS).toBeNull();
    expect(loadEnv({ FAKE_META_CALL_DELAYS_MS: 'off' }).FAKE_META_CALL_DELAYS_MS).toBeNull();
    expect(
      loadEnv({ NODE_ENV: 'test', FAKE_META_CALL_DELAYS_MS: '1,2,3' }).FAKE_META_CALL_DELAYS_MS,
    ).toEqual([1, 2, 3]);
    for (const bad of ['1,2', 'soon', '1,2,60001']) {
      expect(issuesOf({ FAKE_META_CALL_DELAYS_MS: bad }).issues.map((i) => i.variable)).toEqual([
        'FAKE_META_CALL_DELAYS_MS',
      ]);
    }
    const prod = { ...validProduction, WHATSAPP_ENABLED: 'false' };
    expect(loadEnv(prod).FAKE_META_CALL_DELAYS_MS).toBeNull();
    expect(
      issuesOf({ ...prod, FAKE_META_CALL_DELAYS_MS: '1,2,3' }).issues.map((i) => i.variable),
    ).toEqual(['FAKE_META_CALL_DELAYS_MS']);
  });
});
