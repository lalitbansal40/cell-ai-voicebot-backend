import { afterAll, beforeAll } from 'vitest';

import { setEmail, type EmailService, type EmailTemplateKey } from '../../src/core/email';

export interface CapturedEmail {
  template: EmailTemplateKey;
  to: string;
  vars: Record<string, unknown>;
  dedupeKey?: string;
}

/**
 * Replaces the global email service with one that records `enqueue` calls
 * (no Redis queue needed). Returns the live list.
 */
export const useCapturedEmail = (): CapturedEmail[] => {
  const sent: CapturedEmail[] = [];
  const service: EmailService = {
    driver: 'memory',
    send: () => Promise.resolve({ messageId: 'captured' }),
    sendTemplate: () => Promise.resolve({ messageId: 'captured' }),
    enqueue: (template, to, vars, options) => {
      sent.push({
        template,
        to,
        vars: vars as unknown as Record<string, unknown>,
        dedupeKey: options?.dedupeKey,
      });
      return Promise.resolve({ jobId: String(sent.length) });
    },
  };
  beforeAll(() => setEmail(service));
  afterAll(() => setEmail(undefined));
  return sent;
};

/** Latest captured email of a template to an address. */
export const lastEmail = (sent: CapturedEmail[], template: EmailTemplateKey, to: string) =>
  [...sent].reverse().find((e) => e.template === template && e.to === to.toLowerCase());
