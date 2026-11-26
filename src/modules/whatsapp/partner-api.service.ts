import { Types } from 'mongoose';

import { PARTNER_API_CONFIG } from '../../config/partner-api';
import { isMetaApiError } from '../../core/meta';
import { PINNACLE_API_VERSION } from '../../core/meta/pinnacle.client';
import { UserModel, type UserDoc } from '../../db/models/user.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError, TooManyAttemptsError } from '../../shared/errors/app-error';
import { recordAudit, type AuditActorInput } from '../audit/audit.service';
import { LOCKOUT_THRESHOLD, LOCKOUT_WINDOW_SEC } from '../auth/auth.constants';
import { spendMfaCode } from '../auth/mfa.service';
import { verifyPassword } from '../auth/password';

import { openSecret, type WhatsAppContext } from './context';
import {
  fillPartnerPath,
  PARTNER_API_ENDPOINTS,
  PARTNER_API_GROUPS,
  partnerEndpoint,
} from './partner-api.catalogue';
import { PINNACLE_SECRET_HEADER, pinnacleWebhookUrl } from './pinnacle-webhooks.service';

/**
 * PIN: the Pinnacle partner API reference for superadmins — base URLs, the managed numbers of
 * an account with their key (masked; revealed only after the superadmin's own password + code)
 * and a read-only "Try it" through our backend (the key never reaches the browser there).
 */

const SECRET_SELECT = '+tokenSealed';

const managedChannels = (accountId: Types.ObjectId) =>
  WhatsAppChannelModel.find({
    accountId,
    provider: 'pinnacle',
    status: { $ne: 'disconnected' },
  })
    .select(SECRET_SELECT)
    .sort({ createdAt: 1 })
    .lean<WhatsAppChannelDoc[]>();

const keyOf = (ctx: Pick<WhatsAppContext, 'key'>, channel: WhatsAppChannelDoc): string | null => {
  if (!channel.tokenSealed) return null;
  try {
    return openSecret(ctx, channel.tokenSealed);
  } catch {
    return null;
  }
};

/** Every run of ≥ 8 digits → `…last4`; key / token / secret fields dropped (Try it answers). */
export const maskPartnerBody = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replace(/\d{8,}/g, (d) => `…${d.slice(-4)}`);
  if (Array.isArray(value)) return value.map(maskPartnerBody);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !/api.?key|token|secret|password|authorization/i.test(k))
        .map(([k, v]) => [k, maskPartnerBody(v)]),
    );
  }
  return value;
};

/** Ids (phone number id / WABA id) are not phone numbers: shown as they are. */
const keepIds = (value: unknown, ids: string[]): unknown => {
  if (typeof value === 'string') {
    let out = value;
    for (const id of ids) out = out.replaceAll(`…${id.slice(-4)}`, id);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => keepIds(v, ids));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, keepIds(v, ids)]),
    );
  }
  return value;
};

const baseUrls = (ctx: Pick<WhatsAppContext, 'env'>) => {
  const base = ctx.env.PINNACLE_BASE_URL.replace(/\/+$/, '');
  const voice = (ctx.env.PINNACLE_VOICE_BASE_URL ?? ctx.env.PINNACLE_BASE_URL).replace(/\/+$/, '');
  return {
    baseUrl: `${base}/${PINNACLE_API_VERSION}`,
    voiceBaseUrl: `${voice}/${PINNACLE_API_VERSION}`,
  };
};

/** `GET …/partner-api` — never the key itself or the webhook secret. */
export const partnerApiInfo = async (ctx: WhatsAppContext, accountId: Types.ObjectId) => {
  const rows = await managedChannels(accountId);
  const numbers = rows.map((c) => ({
    channelId: c._id.toString(),
    label: c.label,
    status: c.status,
    wabaId: c.wabaId,
    phoneNumberId: c.phoneNumberId,
    displayPhoneNumber: c.displayPhoneNumber,
    keyConfigured: Boolean(c.tokenSealed),
    keyLast4: c.pinnacle?.keyLast4 ?? null,
    keyCheckedAt: c.pinnacle?.keyCheckedAt?.toISOString() ?? null,
    webhook: {
      url: pinnacleWebhookUrl(ctx.env, c._id),
      headerName: PINNACLE_SECRET_HEADER,
      setAt: c.pinnacle?.webhookSetAt?.toISOString() ?? null,
    },
  }));
  return {
    configured: numbers.some((n) => n.keyConfigured),
    ...baseUrls(ctx),
    authHeader: 'apikey',
    errorFormat: {
      example: { code: 400, status: 'failed', message: 'Invalid parameter' },
      note: 'The partner sometimes answers an error with HTTP 200 and `status: "failed"`.',
    },
    numbers,
    groups: PARTNER_API_GROUPS,
    endpoints: PARTNER_API_ENDPOINTS,
  };
};

const loadManaged = async (ctx: WhatsAppContext, accountId: Types.ObjectId, channelId: string) => {
  if (!Types.ObjectId.isValid(channelId)) throw new NotFoundError('WhatsApp number not found');
  const channel = await WhatsAppChannelModel.findOne({
    _id: channelId,
    accountId,
    provider: 'pinnacle',
    status: { $ne: 'disconnected' },
  })
    .select(SECRET_SELECT)
    .lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  const key = keyOf(ctx, channel);
  if (!key)
    throw new AppError(
      'CONFLICT_INVALID_STATE',
      'No partner API key is configured for this number.',
    );
  return { channel, key };
};

/** A per-superadmin counter (Redis); over `limit` → 429. */
const limited = async (
  ctx: WhatsAppContext,
  name: string,
  superadminId: string,
  limit: number,
  windowSec: number,
) => {
  const key = `partner-api:${name}:${superadminId}`;
  const n = await ctx.redis.incr(key);
  if (n === 1) await ctx.redis.expire(key, windowSec);
  if (n > limit) {
    const ttl = await ctx.redis.ttl(key);
    throw new AppError('RATE_LIMITED', 'Too many requests — try again later.', undefined, {
      retryAfterSec: Math.max(ttl, 1),
    });
  }
};

/** The superadmin's own password (+ two-step code when set up), with the login lockout. */
const confirmSuperadmin = async (
  ctx: WhatsAppContext,
  superadminId: string,
  input: { password: string; code?: string | undefined },
) => {
  const failKey = `partner-api:reveal-fail:${superadminId}`;
  const [count, ttl] = await Promise.all([ctx.redis.get(failKey), ctx.redis.ttl(failKey)]);
  if (Number(count ?? 0) >= LOCKOUT_THRESHOLD) {
    throw new TooManyAttemptsError(ttl > 0 ? ttl : LOCKOUT_WINDOW_SEC);
  }
  const fail = async (code: 'REAUTH_FAILED' | 'MFA_REQUIRED' | 'MFA_INVALID') => {
    const n = await ctx.redis.incr(failKey);
    if (n === 1) await ctx.redis.expire(failKey, LOCKOUT_WINDOW_SEC);
    throw new AppError(code);
  };
  const user = await UserModel.findById(superadminId).select('+passwordHash +mfa').lean<UserDoc>();
  if (!user || user.platformRole !== 'superadmin') throw new AppError('AUTH_FORBIDDEN');
  if (!user.passwordHash || !(await verifyPassword(user.passwordHash, input.password)).ok) {
    return fail('REAUTH_FAILED');
  }
  if (user.mfa?.enabledAt) {
    if (!input.code) return fail('MFA_REQUIRED');
    try {
      await spendMfaCode(user, input.code);
    } catch (err) {
      if (err instanceof AppError && err.code === 'MFA_INVALID') return fail('MFA_INVALID');
      throw err;
    }
  }
  await ctx.redis.del(failKey);
};

export interface PartnerActor {
  /** The superadmin (their own id, also in a full-access login-as). */
  superadminId: string;
  audit: AuditActorInput;
  ip: string | null;
}

/** Reveal a managed number's API key — password (+ code) first, 5 / hour, audited. */
export const revealPartnerKey = async (
  ctx: WhatsAppContext,
  accountId: Types.ObjectId,
  channelId: string,
  actor: PartnerActor,
  input: { password: string; code?: string | undefined },
) => {
  const { channel, key } = await loadManaged(ctx, accountId, channelId);
  await confirmSuperadmin(ctx, actor.superadminId, input);
  await limited(ctx, 'reveal', actor.superadminId, PARTNER_API_CONFIG.revealsPerHour, 3600);
  await recordAudit({
    accountId,
    actor: actor.audit,
    action: 'whatsapp.managed_key_revealed',
    target: { type: 'whatsapp_channel', id: channel._id.toString() },
    meta: { channelId: channel._id.toString(), keyLast4: key.slice(-4) },
    ip: actor.ip,
  });
  return { apiKey: key, keyLast4: key.slice(-4), expiresInSec: PARTNER_API_CONFIG.revealShowSec };
};

/** Try it: a safe read of the partner API with the number's key (our server only). */
export const tryPartnerApi = async (
  ctx: WhatsAppContext,
  accountId: Types.ObjectId,
  channelId: string,
  actor: PartnerActor,
  input: { endpointId: string },
) => {
  const endpoint = partnerEndpoint(input.endpointId);
  if (!endpoint?.tryIt || endpoint.method !== 'GET') {
    throw new AppError('PARTNER_API_OP_NOT_ALLOWED');
  }
  if (!ctx.pinnacle) throw new AppError('WA_PROVIDER_NOT_CONFIGURED');
  const { channel, key } = await loadManaged(ctx, accountId, channelId);
  await limited(ctx, 'try', actor.superadminId, PARTNER_API_CONFIG.tryPer10Min, 600);
  const ids = { phoneNumberId: channel.phoneNumberId ?? '', wabaId: channel.wabaId };
  const path = fillPartnerPath(endpoint.path, ids);
  const started = Date.now();
  let ok = true;
  let httpStatus = 200;
  let body: unknown;
  try {
    body = await ctx.pinnacle.partnerGet(key, path);
  } catch (err) {
    ok = false;
    httpStatus = isMetaApiError(err) ? err.status : 502;
    body = {
      error: isMetaApiError(err)
        ? { code: err.code, type: err.type, message: err.detail ?? err.message }
        : { message: (err as Error).name },
    };
  }
  const masked = keepIds(maskPartnerBody(body), [ids.phoneNumberId, ids.wabaId].filter(Boolean));
  let text = JSON.stringify(masked) ?? 'null';
  if (text.length > PARTNER_API_CONFIG.tryBodyMaxChars)
    text = `${text.slice(0, PARTNER_API_CONFIG.tryBodyMaxChars)}…`;
  await recordAudit({
    accountId,
    actor: actor.audit,
    action: 'whatsapp.partner_api_called',
    target: { type: 'whatsapp_channel', id: channel._id.toString() },
    meta: { channelId: channel._id.toString(), endpointId: endpoint.id, httpStatus },
    ip: actor.ip,
  });
  return {
    endpointId: endpoint.id,
    ok,
    httpStatus,
    durationMs: Date.now() - started,
    body: text.length >= PARTNER_API_CONFIG.tryBodyMaxChars ? text : masked,
  };
};
