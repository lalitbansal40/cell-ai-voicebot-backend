import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from './logger';

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  return { lines, stream };
};

describe('createLogger', () => {
  it('writes JSON with service metadata and ISO time', () => {
    const { lines, stream } = capture();
    createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'info' }, stream).info('hello');
    expect(lines[0]).toMatchObject({
      msg: 'hello',
      service: 'cell-ai-voicebot-backend',
      env: 'test',
    });
    expect(String(lines[0]?.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('redacts secrets and auth headers', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'info' }, stream);
    logger.info(
      {
        user: { password: 'p@ss-123', apiKey: 'key-456' },
        req: { headers: { authorization: 'Bearer abc' } },
      },
      'x',
    );
    const out = JSON.stringify(lines[0]);
    expect(out).not.toContain('p@ss-123');
    expect(out).not.toContain('key-456');
    expect(out).not.toContain('Bearer abc');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts auth secrets: bodies, password fields, OTPs, tokens, cookies', () => {
    const { lines, stream } = capture();
    const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'info' }, stream);
    logger.info(
      {
        req: {
          body: { email: 'a@b.co', code: '123456' },
          headers: { cookie: 'cav_rt=raw-cookie' },
        },
        change: { currentPassword: 'old-pass-1', newPassword: 'new-pass-2' },
        otpBlock: { otp: '654321', resetToken: 'reset-raw', inviteToken: 'invite-raw' },
        session: { accessToken: 'jwt-raw', refreshToken: 'rt-raw' },
        res: { headers: { 'set-cookie': 'cav_rt=set-raw' } },
        code: 'AUTH_CODE_INVALID',
      },
      'x',
    );
    const out = JSON.stringify(lines[0]);
    for (const secret of [
      '123456',
      'raw-cookie',
      'old-pass-1',
      'new-pass-2',
      '654321',
      'reset-raw',
      'invite-raw',
      'jwt-raw',
      'rt-raw',
      'set-raw',
    ]) {
      expect(out).not.toContain(secret);
    }
    // error codes stay readable
    expect(out).toContain('AUTH_CODE_INVALID');
  });

  it('respects the log level', () => {
    const { lines, stream } = capture();
    createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }, stream).error('hidden');
    expect(lines).toHaveLength(0);
  });
});
