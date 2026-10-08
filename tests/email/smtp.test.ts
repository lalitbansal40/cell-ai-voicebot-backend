import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmailPermanentError, SmtpEmailProvider, toEmailError } from '../../src/core/email';
import { createLogger } from '../../src/shared/logger';

const FAKE_USER = 'smtp-user';
const FAKE_PASS = 'smtp-pass-not-real';
const REJECTED = 'nobody@example.com';

interface Received {
  from: string;
  to: string[];
  raw: string;
}

const startServer = async (opts: { auth: boolean }) => {
  const received: Received[] = [];
  const server = new SMTPServer({
    logger: false,
    disabledCommands: opts.auth ? ['STARTTLS'] : ['STARTTLS', 'AUTH'],
    authOptional: !opts.auth,
    allowInsecureAuth: true,
    onAuth: (auth, _session, cb) => {
      if (auth.username === FAKE_USER && auth.password === FAKE_PASS) cb(null, { user: FAKE_USER });
      else cb(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
    },
    onRcptTo: (address, _session, cb) => {
      if (address.address === REJECTED) {
        cb(Object.assign(new Error('No such user'), { responseCode: 550 }));
      } else cb();
    },
    onData: (stream, session, cb) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
};

const captureLogger = () => {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'debug' }, stream), lines };
};

const envFor = (port: number, auth?: { user: string; pass: string }) => ({
  NODE_ENV: 'test' as const,
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: port,
  SMTP_SECURE: false,
  SMTP_USER: auth?.user,
  SMTP_PASS: auth?.pass,
  MAIL_FROM: 'Cell AI Voicebot <no-reply@example.com>',
});

const message = (to = 'user@example.com') => ({
  to,
  subject: 'Hello from tests',
  html: '<p>body-html-marker</p>',
  text: 'body-text-marker',
});

describe('SmtpEmailProvider (in-process SMTP server)', () => {
  let open: Awaited<ReturnType<typeof startServer>>;
  let authed: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    open = await startServer({ auth: false });
    authed = await startServer({ auth: true });
  });

  afterAll(async () => {
    await open.close();
    await authed.close();
  });

  it('delivers a message with From, To and Subject; logs without the body', async () => {
    const { logger, lines } = captureLogger();
    const provider = new SmtpEmailProvider(envFor(open.port), logger);
    const { messageId } = await provider.send(message());
    await provider.close();

    expect(messageId).toMatch(/^<.+>$/);
    const mail = open.received.at(-1);
    expect(mail?.from).toBe('no-reply@example.com');
    expect(mail?.to).toEqual(['user@example.com']);
    expect(mail?.raw).toContain('Subject: Hello from tests');
    expect(mail?.raw).toContain('From: Cell AI Voicebot <no-reply@example.com>');
    expect(mail?.raw).toContain('body-text-marker');
    const log = lines.join('');
    expect(log).toContain('u***@example.com');
    expect(log).not.toContain('body-html-marker');
    expect(log).not.toContain('user@example.com');
  });

  it('authenticates with SMTP_USER / SMTP_PASS', async () => {
    const provider = new SmtpEmailProvider(
      envFor(authed.port, { user: FAKE_USER, pass: FAKE_PASS }),
      createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    );
    await provider.send(message('auth@example.com'));
    await provider.close();
    expect(authed.received.at(-1)?.to).toEqual(['auth@example.com']);
  });

  it('fails on wrong credentials without leaking the password', async () => {
    const { logger, lines } = captureLogger();
    const provider = new SmtpEmailProvider(
      envFor(authed.port, { user: FAKE_USER, pass: 'wrong-pass-value' }),
      logger,
    );
    const err = (await provider.send(message()).catch((e: unknown) => e)) as Error;
    await provider.close();
    expect(err).toBeInstanceOf(EmailPermanentError);
    expect(err.message).not.toContain('wrong-pass-value');
    expect(lines.join('')).not.toContain('wrong-pass-value');
  });

  it('maps a 550 recipient rejection to a permanent error', async () => {
    const provider = new SmtpEmailProvider(
      envFor(open.port),
      createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    );
    const err = await provider.send(message(REJECTED)).catch((e: unknown) => e);
    await provider.close();
    expect(err).toBeInstanceOf(EmailPermanentError);
    expect((err as Error).message).toBe('SMTP rejected the message (550)');
  });

  it('maps a refused connection to a retryable provider error', async () => {
    const closed = await startServer({ auth: false });
    await closed.close();
    const provider = new SmtpEmailProvider(
      envFor(closed.port),
      createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    );
    const err = await provider.send(message()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PROVIDER_ERROR' });
    expect(err).not.toBeInstanceOf(EmailPermanentError);
    expect(await provider.verify()).toBe(false);
    await provider.close();
  });

  it('verify() is true against a live server', async () => {
    const provider = new SmtpEmailProvider(
      envFor(open.port),
      createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    );
    expect(await provider.verify()).toBe(true);
    await provider.close();
  });
});

describe('toEmailError', () => {
  it('treats 5xx as permanent and everything else as retryable', () => {
    expect(toEmailError({ responseCode: 554 })).toBeInstanceOf(EmailPermanentError);
    expect(toEmailError({ responseCode: 451 })).not.toBeInstanceOf(EmailPermanentError);
    expect(toEmailError({ code: 'ETIMEDOUT' }).message).toBe('SMTP delivery failed (ETIMEDOUT)');
    expect(toEmailError(new Error('x')).message).toBe('SMTP delivery failed (unknown)');
  });
});
