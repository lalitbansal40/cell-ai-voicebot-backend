import type { Redis } from 'ioredis';

import type { Env } from '../../config/env';
import { open, seal } from '../../core/ai/secret-box';
import type { MetaClient } from '../../core/meta';

/** Everything the WhatsApp services need (built once by the server, injected in tests). */
export interface WhatsAppContext {
  env: Env;
  meta: MetaClient;
  redis: Redis;
  /** Secret-box key (`secretBoxKey(env)`) — seals business tokens and PINs. */
  key: Buffer;
  now?: () => Date;
}

export const nowOf = (ctx: Pick<WhatsAppContext, 'now'>): Date => ctx.now?.() ?? new Date();

export const sealSecret = (ctx: Pick<WhatsAppContext, 'key'>, plain: string): string =>
  seal(ctx.key, plain);

export const openSecret = (ctx: Pick<WhatsAppContext, 'key'>, sealed: string): string =>
  open(ctx.key, sealed);

/** `+91 90000 00010` → `+919000000010` (null when it isn't a number). */
export const toE164 = (display: string | null | undefined): string | null => {
  const digits = display?.replace(/\D/g, '') ?? '';
  return digits.length >= 8 ? `+${digits}` : null;
};

/** Last 4 digits of the business number (audit / emails). */
export const phoneLast4 = (display: string | null | undefined): string =>
  (display?.replace(/\D/g, '') ?? '').slice(-4);
