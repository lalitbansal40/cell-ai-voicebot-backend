import type { Env } from '../../config/env';
import type { Logger } from '../../shared/logger';

import type { EmailService } from './email.service';
import type { EmailProvider } from './email.types';
import { LogEmailProvider } from './log.provider';
import { SmtpEmailProvider } from './smtp.provider';

export * from './email.service';
export * from './email.types';
export * from './templates';
export { LogEmailProvider } from './log.provider';
export { MemoryEmailProvider } from './memory.provider';
export { SmtpEmailProvider, toEmailError } from './smtp.provider';

/** Picks the provider from EMAIL_DRIVER (smtp | log). */
export const createEmailProvider = (env: Env, logger: Logger): EmailProvider =>
  env.EMAIL_DRIVER === 'smtp' ? new SmtpEmailProvider(env, logger) : new LogEmailProvider(logger);

let instance: EmailService | undefined;

/** Set once by the server at startup; modules send through `getEmail()`. */
export const setEmail = (service: EmailService | undefined): void => {
  instance = service;
};

export const getEmail = (): EmailService => {
  if (!instance) throw new Error('Email service not initialised (server not started)');
  return instance;
};
