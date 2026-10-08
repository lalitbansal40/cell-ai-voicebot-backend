import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  createEmailService,
  escapeHtml,
  isEmailTemplateKey,
  LogEmailProvider,
  MemoryEmailProvider,
  renderTemplate,
} from '../../src/core/email';
import { createLogger } from '../../src/shared/logger';

const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

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

describe('email templates', () => {
  it('escapes all five HTML special characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('renders system.test with escaped values and a text part', () => {
    const email = renderTemplate('system.test', { name: '<script>alert(1)</script>' });
    expect(email.subject).toBe('Test email from Cell AI Voicebot');
    expect(email.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(email.html).not.toContain('<script>alert(1)');
    expect(email.html).toContain('<!doctype html>');
    expect(email.text).toContain('This is a test email.');
    // text/plain is not HTML — values stay verbatim there.
    expect(email.text).toContain('Hi <script>alert(1)</script>,');
  });

  it('knows its template keys', () => {
    expect(isEmailTemplateKey('system.test')).toBe(true);
    expect(isEmailTemplateKey('nope')).toBe(false);
    expect(isEmailTemplateKey('toString')).toBe(false);
  });
});

describe('LogEmailProvider', () => {
  it('logs the masked recipient and subject but never the body', async () => {
    const { logger, lines } = captureLogger();
    const provider = new LogEmailProvider(logger);
    const result = await provider.send({
      to: 'customer@example.com',
      subject: 'Reset your password',
      html: '<p>secret-reset-link-123</p>',
      text: 'secret-reset-link-123',
    });
    expect(result.messageId).toMatch(/^log-[a-f0-9]{12}$/);
    const out = lines.join('');
    expect(out).toContain('c***@example.com');
    expect(out).toContain('Reset your password');
    expect(out).not.toContain('customer@example.com');
    expect(out).not.toContain('secret-reset-link-123');
    expect(await provider.verify()).toBe(true);
    await expect(provider.close()).resolves.toBeUndefined();
  });
});

describe('createEmailService', () => {
  it('renders and sends a template through the provider', async () => {
    const provider = new MemoryEmailProvider();
    const service = createEmailService({ provider, logger: silent });
    expect(service.driver).toBe('memory');
    const { messageId } = await service.sendTemplate('system.test', 'user@example.com', {
      name: 'Asha',
    });
    expect(messageId).toBe('mem-1');
    expect(provider.sent[0]).toMatchObject({
      to: 'user@example.com',
      subject: 'Test email from Cell AI Voicebot',
    });
    provider.clear();
    expect(provider.sent).toHaveLength(0);
  });

  it('rejects an invalid recipient', async () => {
    const service = createEmailService({ provider: new MemoryEmailProvider(), logger: silent });
    await expect(
      service.sendTemplate('system.test', 'not-an-email', { name: 'x' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'to' }] });
    await expect(service.enqueue('system.test', 'bad@', { name: 'x' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects a multi-line subject (header injection)', async () => {
    const service = createEmailService({ provider: new MemoryEmailProvider(), logger: silent });
    await expect(
      service.send({
        to: 'user@example.com',
        subject: 'Hi\r\nBcc: victim@example.com',
        html: '<p>x</p>',
        text: 'x',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'subject' }] });
  });

  it('refuses to enqueue without a queue', async () => {
    const service = createEmailService({ provider: new MemoryEmailProvider(), logger: silent });
    await expect(service.enqueue('system.test', 'user@example.com', { name: 'x' })).rejects.toThrow(
      'Email queue is not configured',
    );
  });

  it('propagates provider failures', async () => {
    const provider = new MemoryEmailProvider();
    provider.failWith = new Error('down');
    const service = createEmailService({ provider, logger: silent });
    await expect(
      service.sendTemplate('system.test', 'user@example.com', { name: 'x' }),
    ).rejects.toThrow('down');
  });
});

describe('email subjects never contain secrets (they are logged)', () => {
  it('keeps codes, tokens and links out of every subject', () => {
    const SECRET = 'S3CR3T-123456';
    const rendered = [
      renderTemplate('auth.verify_email', { name: 'A', code: SECRET, minutes: 10 }),
      renderTemplate('auth.account_exists', {
        name: 'A',
        loginUrl: `https://x/${SECRET}`,
        resetUrl: `https://x/${SECRET}`,
      }),
      renderTemplate('auth.reset_password', {
        name: 'A',
        resetUrl: `https://x/?token=${SECRET}`,
        minutes: 30,
      }),
      renderTemplate('auth.password_changed', {
        name: 'A',
        at: 'now',
        resetUrl: `https://x/${SECRET}`,
      }),
    ];
    for (const email of rendered) expect(email.subject).not.toContain(SECRET);
  });
});

describe('auth templates', () => {
  it('render escaped HTML + text for every auth template', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const cases = [
      renderTemplate('auth.verify_email', { name: evil, code: '042917', minutes: 10 }),
      renderTemplate('auth.account_exists', {
        name: evil,
        loginUrl: 'https://app/login?a=1&b="2"',
        resetUrl: 'https://app/reset',
      }),
      renderTemplate('auth.reset_password', {
        name: evil,
        resetUrl: 'https://app/reset?token=abc',
        minutes: 30,
      }),
      renderTemplate('auth.password_changed', {
        name: evil,
        at: 'Thu, 08 Oct 2026',
        resetUrl: 'https://app/reset',
      }),
    ];
    for (const email of cases) {
      expect(email.html).not.toContain('<img src=x');
      expect(email.html).toContain('&lt;img');
      expect(email.text.length).toBeGreaterThan(20);
      expect(email.subject).toMatch(/Cell AI Voicebot/);
    }
    expect(cases[0]?.subject).toBe('Your Cell AI Voicebot verification code');
    expect(cases[0]?.html).toContain('042917');
    expect(cases[0]?.text).toContain('042917');
    expect(cases[1]?.html).toContain('a=1&amp;b=&quot;2&quot;');
    expect(cases[2]?.text).toContain('https://app/reset?token=abc');
  });
});
