import type { Redis } from 'ioredis';

import type { Env } from '../../config/env';
import type { MetaClient, PinnacleClient } from '../../core/meta';
import type { WhatsAppChannelDoc } from '../../db/models/whatsapp-channel.model';
import { open, seal, type SecretKey } from '../../shared/crypto/secret-box';
import { AppError } from '../../shared/errors/app-error';

/** Everything the WhatsApp services need (built once by the server, injected in tests). */
export interface WhatsAppContext {
  env: Env;
  meta: MetaClient;
  /** PN: the Pinnacle partner API for managed numbers (`null` / absent when off). */
  pinnacle?: PinnacleClient | null;
  redis: Redis;
  /** Secret-box key (`secretBoxKey(env)`) — seals business tokens and PINs. */
  key: SecretKey;
  now?: () => Date;
  /**
   * Phase 12 webhook fast path: a newly stored `calls` event is handed to the call
   * bus at once (ids + kinds only). The worker still processes the stored row.
   */
  callsFastPath?: (event: CallsFastPathEvent) => Promise<void>;
}

export interface CallsFastPathEvent {
  eventId: string;
  waCallId: string;
  /** `connect` / `terminate` / `RINGING` / `ACCEPTED` / `REJECTED` … */
  kind: string;
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

/** PN: is this a managed number (every call goes through the Pinnacle partner API)? */
export const isPinnacle = (channel: Pick<WhatsAppChannelDoc, 'provider'>): boolean =>
  channel.provider === 'pinnacle';

/**
 * PMC: how a number's calls reach WhatsApp — our app (`meta`), the partner (`pinnacle`, which
 * can't call), or our app's token on a managed number (`meta_direct`).
 */
export type CallingVia = 'meta' | 'pinnacle' | 'meta_direct';

export const callingViaOf = (
  channel: Pick<WhatsAppChannelDoc, 'provider' | 'metaCalling'>,
): CallingVia => {
  if (!isPinnacle(channel)) return 'meta';
  return channel.metaCalling?.status === 'on' ? 'meta_direct' : 'pinnacle';
};

/**
 * PMC (D5): the client + token for **calling** APIs of a channel. A managed number with
 * Meta calling on uses the Graph API with its own sealed token (messages stay on the
 * partner); `error` refuses (`WA_META_CALLING_BROKEN`); everything else = `clientFor` and
 * the channel token. Every call API of `modules/whatsapp-calling` goes through here.
 */
export const callingClientFor = (
  ctx: Pick<WhatsAppContext, 'meta' | 'pinnacle' | 'key'>,
  channel: Pick<WhatsAppChannelDoc, 'provider' | 'metaCalling'>,
  channelToken: string,
): { api: MetaClient; token: string; via: CallingVia } => {
  if (isPinnacle(channel) && channel.metaCalling?.status === 'error') {
    throw new AppError('WA_META_CALLING_BROKEN');
  }
  const via = callingViaOf(channel);
  if (via !== 'meta_direct') return { api: clientFor(ctx, channel), token: channelToken, via };
  const sealed = channel.metaCalling?.tokenSealed;
  if (!sealed) throw new AppError('WA_META_CALLING_BROKEN');
  let token: string;
  try {
    token = openSecret(ctx, sealed);
  } catch {
    throw new AppError('WA_META_CALLING_BROKEN');
  }
  return { api: ctx.meta, token, via };
};

/**
 * PN (D7): the API client for a channel — Pinnacle for managed numbers, Meta otherwise.
 * Every channel-bound call goes through here (`routing.guard.test.ts`).
 */
export const clientFor = (
  ctx: Pick<WhatsAppContext, 'meta' | 'pinnacle'>,
  channel: Pick<WhatsAppChannelDoc, 'provider'>,
): MetaClient => {
  if (!isPinnacle(channel)) return ctx.meta;
  if (!ctx.pinnacle) throw new AppError('WA_PROVIDER_NOT_CONFIGURED');
  return ctx.pinnacle;
};
