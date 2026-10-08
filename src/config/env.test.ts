import { describe, expect, it } from 'vitest';

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
        'ENCRYPTION_KEY',
        'FRONTEND_URL',
        'JWT_ACCESS_SECRET',
        'JWT_REFRESH_SECRET',
        'MONGODB_URI',
        'REDIS_URL',
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
