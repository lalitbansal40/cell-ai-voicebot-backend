import { Types } from 'mongoose';

import { isMetaApiError, REQUIRED_META_SCOPES, type MetaDebugToken } from '../../core/meta';
import {
  defaultMetaCalling,
  WhatsAppChannelModel,
  type MetaCallingMethod,
  type WaMetaCalling,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { callingUnavailableReason } from '../whatsapp-calling/availability';

import { metaCallingJson } from './channel-json';
import { auditChannel, emitChannelUpdated, type WaActor } from './channel-status';
import { isPinnacle, nowOf, openSecret, sealSecret, type WhatsAppContext } from './context';
import { notReady, signupError, signupFailed } from './errors';
import { noteMetaCallingBroken } from './meta-calling-alerts';
import { checkWebhook } from './webhook-check';
import { resetManagedNumbersCache } from './webhooks.service';

/**
 * PMC: calls of a managed (Pinnacle) number over the Meta Graph API with our app's token.
 * Messages, templates, campaigns, media and the credit line stay on the partner; the
 * partner's credit line keeps paying Meta for the WABA (calls included).
 *
 * Turn on: token (Embedded Signup code, or a System User token from the platform team) →
 * the token sees this WABA and number → our app subscribed to the WABA + `calls` on the app
 * webhook → calling ON at WhatsApp → `metaCalling.status = 'on'`.
 */

export const META_CALLING_STEPS = [
  'token',
  'verify',
  'app_subscribed',
  'fields',
  'calling_on',
] as const;
export type MetaCallingStepKey = (typeof META_CALLING_STEPS)[number];
export interface MetaCallingStep {
  key: MetaCallingStepKey;
  ok: boolean;
  detail: string | null;
}

export type MetaCallingInput =
  | { code: string; wabaId?: string | undefined; phoneNumberId?: string | undefined }
  | { accessToken: string };

/** 6 turn-on / check attempts per 10 minutes per number. */
export const META_CALLING_MAX = 6;
export const META_CALLING_WINDOW_SEC = 600;

const SELECT = '+metaCalling.tokenSealed';

const message = (err: unknown): string =>
  (isMetaApiError(err) || err instanceof Error ? err.message : String(err)).slice(0, 300);

const last4 = (token: string) => token.slice(-4);

export interface MetaCallingHooks {
  /** After a turn-on / off / status change: read the call settings again (calling jobs). */
  onChanged?: (channel: WhatsAppChannelDoc) => Promise<void>;
}

export const createMetaCallingService = (ctx: WhatsAppContext, hooks: MetaCallingHooks = {}) => {
  const { meta, redis } = ctx;
  const log = () => getLogger();

  const load = async (accountId: Types.ObjectId, id: string) => {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('WhatsApp number not found');
    const channel = await WhatsAppChannelModel.findOne({ _id: id, accountId })
      .select(SELECT)
      .lean<WhatsAppChannelDoc>();
    if (!channel) throw new NotFoundError('WhatsApp number not found');
    return channel;
  };

  const reload = async (id: Types.ObjectId) =>
    (await WhatsAppChannelModel.findById(id).lean<WhatsAppChannelDoc>())!;

  const stateOf = (channel: WhatsAppChannelDoc): WaMetaCalling =>
    channel.metaCalling ?? defaultMetaCalling();

  const guard = (channel: WhatsAppChannelDoc) => {
    if (!ctx.env.WA_META_CALLING_ENABLED) throw new AppError('WA_META_CALLING_DISABLED');
    if (!isPinnacle(channel)) throw new AppError('WHATSAPP_META_CALLING_NOT_MANAGED');
    if (channel.status === 'disconnected') throw notReady('This WhatsApp number is disconnected.');
  };

  const rateLimit = async (id: string) => {
    const key = `wa-rl-metacalling-${id}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, META_CALLING_WINDOW_SEC);
    if (used > META_CALLING_MAX) {
      const ttl = await redis.ttl(key);
      throw new AppError(
        'RATE_LIMITED',
        'Too many tries for calls on this number — try again in a few minutes.',
        undefined,
        { retryAfterSec: Math.max(ttl, 1) },
      );
    }
  };

  const tokenOf = (channel: WhatsAppChannelDoc): string | null => {
    const sealed = channel.metaCalling?.tokenSealed;
    if (!sealed) return null;
    try {
      return openSecret(ctx, sealed);
    } catch {
      log().error({ channelId: channel._id.toString() }, 'meta calling: token could not be opened');
      return null;
    }
  };

  /** D7: the token is valid, has both WhatsApp scopes, sees this WABA and this number. */
  const verify = async (channel: WhatsAppChannelDoc, token: string): Promise<MetaDebugToken> => {
    let info: MetaDebugToken;
    try {
      info = await meta.debugToken(token); // meta-only: our app's token
    } catch (err) {
      throw signupError(err, 'verify');
    }
    if (!info.isValid) {
      throw signupFailed('verify', "Meta didn't confirm the access — sign in with Facebook again.");
    }
    if (REQUIRED_META_SCOPES.some((s) => !info.scopes.includes(s))) {
      throw new AppError('WHATSAPP_META_CALLING_SCOPES');
    }
    // a System User token lists no granular targets when it has every asset of the business
    if (info.grantedWabaIds.length && !info.grantedWabaIds.includes(channel.wabaId)) {
      throw new AppError('WHATSAPP_META_CALLING_MISMATCH');
    }
    let phones;
    try {
      phones = await meta.listPhoneNumbers(token, channel.wabaId); // meta-only: our app's token
    } catch (err) {
      if (isMetaApiError(err) && (err.tokenInvalid || err.status === 403 || err.code === 100)) {
        throw new AppError('WHATSAPP_META_CALLING_MISMATCH');
      }
      throw signupError(err, 'waba');
    }
    if (!phones.some((p) => p.id === channel.phoneNumberId)) {
      throw new AppError('WHATSAPP_META_CALLING_MISMATCH');
    }
    return info;
  };

  const audit = (
    channel: WhatsAppChannelDoc,
    action:
      | 'whatsapp.meta_calling_enabled'
      | 'whatsapp.meta_calling_disabled'
      | 'whatsapp.meta_calling_failed'
      | 'whatsapp.meta_calling_checked',
    actor: WaActor,
    meta: Record<string, unknown>,
  ) => auditChannel(channel, action, actor, meta);

  const changed = async (channel: WhatsAppChannelDoc) => {
    resetManagedNumbersCache();
    // readiness caches the scope check per token — a new token is read again
    await redis.del(`wa:readiness:calls-webhook`).catch(() => undefined);
    emitChannelUpdated(channel);
    if (!hooks.onChanged) return;
    try {
      await hooks.onChanged(channel);
    } catch (err) {
      log().warn(
        { channelId: channel._id.toString(), errName: (err as Error).name },
        'meta calling: settings sync not queued',
      );
    }
  };

  /** Webhook (subscribe + `calls` field) and calling ON at WhatsApp, with the given token. */
  const finish = async (
    channel: WhatsAppChannelDoc,
    token: string,
    steps: MetaCallingStep[],
    options: { fix: boolean; turnOn: boolean },
  ): Promise<{ ok: boolean; failedStep: string | null; error: string | null }> => {
    const now = nowOf(ctx);
    const check = await checkWebhook(
      ctx,
      { wabaId: channel.wabaId, webhookCheck: stateOf(channel).webhookCheck },
      token,
      { fix: options.fix, now },
    );
    await WhatsAppChannelModel.updateOne(
      { _id: channel._id },
      { $set: { 'metaCalling.webhookCheck': check.state } },
    );
    const subscribed = check.state.appSubscribed === true;
    steps.push({
      key: 'app_subscribed',
      ok: subscribed,
      detail: subscribed ? null : (check.state.error ?? 'Our app is not subscribed to the WABA'),
    });
    const fieldsOk =
      !check.state.missingFields.includes('calls') && check.state.status !== 'unknown';
    steps.push({
      key: 'fields',
      ok: fieldsOk,
      detail: fieldsOk ? null : (check.state.error ?? 'The app webhook has no `calls` field'),
    });
    if (check.state.status !== 'ok') {
      return {
        ok: false,
        failedStep: 'webhook',
        error: check.state.error ?? 'Meta does not send this number’s calls to us yet',
      };
    }
    try {
      // meta-only: our app's token on the managed number (PMC)
      const settings = await meta.getPhoneSettings(token, channel.phoneNumberId ?? '');
      let on = settings.status === 'ENABLED';
      if (!on && options.turnOn) {
        // meta-only: our app's token on the managed number (PMC)
        await meta.updateCallingSettings(token, channel.phoneNumberId ?? '', { status: 'ENABLED' });
        on = true;
      }
      steps.push({
        key: 'calling_on',
        ok: on,
        detail: on ? null : 'Calling is off at WhatsApp — turn it on in Calling settings',
      });
      const unavailable = callingUnavailableReason({ ...channel, metaCalling: undefined });
      await WhatsAppChannelModel.updateOne(
        { _id: channel._id },
        {
          $set: {
            'calling.status': unavailable ? 'unavailable' : on ? 'enabled' : 'disabled',
            'calling.unavailableReason': unavailable,
            'calling.syncedAt': now,
            'calling.lastError': null,
          },
        },
      );
      return { ok: true, failedStep: null, error: null };
    } catch (err) {
      if (isMetaApiError(err) && err.tokenInvalid) throw err;
      steps.push({ key: 'calling_on', ok: false, detail: message(err) });
      return { ok: false, failedStep: 'calling', error: message(err) };
    }
  };

  const fail = async (channel: WhatsAppChannelDoc, step: string, code: string, text: string) => {
    await WhatsAppChannelModel.updateOne(
      { _id: channel._id },
      {
        $set: {
          'metaCalling.status': 'error',
          'metaCalling.checkedAt': nowOf(ctx),
          'metaCalling.error': { code, step, message: text.slice(0, 300) },
          'calling.status': 'unavailable',
          'calling.unavailableReason': 'meta_calling_broken',
        },
      },
    );
  };

  /**
   * `POST /whatsapp/channels/:id/meta-calling` — turn calls over Meta Graph on.
   * `allowToken`: a pasted System User token (platform team only, D2/D15).
   */
  const enable = async (
    accountId: Types.ObjectId,
    id: string,
    input: MetaCallingInput,
    actor: WaActor,
    options: { allowToken: boolean; byAdmin?: boolean },
  ) => {
    const channel = await load(accountId, id);
    guard(channel);
    let method: MetaCallingMethod;
    let token: string;
    if ('accessToken' in input) {
      if (!options.allowToken) throw new AppError('WHATSAPP_META_CALLING_TOKEN_FORBIDDEN');
      method = 'system_user_token';
      token = input.accessToken.trim();
    } else {
      if (
        (input.wabaId && input.wabaId !== channel.wabaId) ||
        (input.phoneNumberId && input.phoneNumberId !== channel.phoneNumberId)
      ) {
        throw new AppError('WHATSAPP_META_CALLING_MISMATCH');
      }
      method = 'embedded_signup';
    }
    await rateLimit(id);
    const steps: MetaCallingStep[] = [];
    const base = { method, ...(options.byAdmin ? { byAdmin: true } : {}) };
    try {
      if (!('accessToken' in input)) {
        try {
          token = (await meta.exchangeCode(input.code)).accessToken; // meta-only: our app
        } catch (err) {
          throw signupError(err, 'exchange');
        }
      }
      steps.push({ key: 'token', ok: true, detail: null });
    } catch (err) {
      await audit(channel, 'whatsapp.meta_calling_failed', actor, { ...base, step: 'token' });
      throw err;
    }
    let info: MetaDebugToken;
    try {
      info = await verify(channel, token!);
      steps.push({ key: 'verify', ok: true, detail: null });
    } catch (err) {
      await audit(channel, 'whatsapp.meta_calling_failed', actor, { ...base, step: 'verify' });
      throw err;
    }
    const now = nowOf(ctx);
    // the token is ours from here: kept even when a later step fails (Check / Fix retries)
    await WhatsAppChannelModel.updateOne(
      { _id: channel._id },
      {
        $set: {
          'metaCalling.method': method,
          'metaCalling.tokenSealed': sealSecret(ctx, token!),
          'metaCalling.tokenLast4': last4(token!),
          'metaCalling.tokenExpiresAt': info.expiresAt,
          'metaCalling.scopes': info.scopes,
          'metaCalling.metaUserId': info.userId,
          'metaCalling.checkedAt': now,
        },
      },
    );
    let result;
    try {
      result = await finish(channel, token!, steps, { fix: true, turnOn: true });
    } catch (err) {
      result = { ok: false, failedStep: 'webhook', error: message(err) };
    }
    if (!result.ok) {
      await fail(channel, result.failedStep ?? 'webhook', 'step_failed', result.error ?? 'Failed');
      const updated = await reload(channel._id);
      await audit(updated, 'whatsapp.meta_calling_failed', actor, {
        ...base,
        step: result.failedStep,
        tokenLast4: last4(token!),
        steps: steps.map((s) => [s.key, s.ok]),
      });
      await changed(updated);
      return { channel: updated, steps };
    }
    await WhatsAppChannelModel.updateOne(
      { _id: channel._id },
      {
        $set: {
          'metaCalling.status': 'on',
          'metaCalling.enabledAt': now,
          'metaCalling.enabledBy': actor.id ? new Types.ObjectId(actor.id.toString()) : null,
          'metaCalling.error': null,
        },
      },
    );
    const updated = await reload(channel._id);
    await audit(updated, 'whatsapp.meta_calling_enabled', actor, {
      ...base,
      tokenLast4: last4(token!),
      steps: steps.map((s) => [s.key, s.ok]),
    });
    await changed(updated);
    return { channel: updated, steps };
  };

  /**
   * `DELETE /whatsapp/channels/:id/meta-calling` — calls back to the partner (which can't
   * call): token removed; our app unsubscribed from the WABA when no Meta-direct number of
   * ours uses it; calling off at WhatsApp too when asked.
   */
  const disable = async (
    accountId: Types.ObjectId,
    id: string,
    input: { turnOffAtWhatsApp?: boolean | undefined },
    actor: WaActor,
    options: { byAdmin?: boolean } = {},
  ) => {
    const channel = await load(accountId, id);
    if (!isPinnacle(channel)) throw new AppError('WHATSAPP_META_CALLING_NOT_MANAGED');
    const state = stateOf(channel);
    if (state.status === 'off' && !state.tokenSealed) {
      throw new ConflictError('CONFLICT_INVALID_STATE', 'Calls over Meta direct are already off.');
    }
    const token = tokenOf(channel);
    let turnedOff = false;
    let unsubscribed = false;
    if (token) {
      if (input.turnOffAtWhatsApp) {
        try {
          // meta-only: our app's token on the managed number (PMC)
          await meta.updateCallingSettings(token, channel.phoneNumberId ?? '', {
            status: 'DISABLED',
          });
          turnedOff = true;
        } catch (err) {
          log().warn(
            { channelId: id, errName: (err as Error).name },
            'meta calling: calling not turned off at WhatsApp',
          );
        }
      }
      const others = await WhatsAppChannelModel.countDocuments({
        _id: { $ne: channel._id },
        wabaId: channel.wabaId,
        status: { $ne: 'disconnected' },
        $or: [{ provider: { $ne: 'pinnacle' } }, { 'metaCalling.status': 'on' }],
      });
      if (!others) {
        try {
          await meta.unsubscribeApp(token, channel.wabaId); // meta-only: our app's webhook
          unsubscribed = true;
        } catch (err) {
          log().warn(
            { channelId: id, errName: (err as Error).name },
            'meta calling: app not unsubscribed from the WABA',
          );
        }
      }
    }
    await WhatsAppChannelModel.updateOne(
      { _id: channel._id },
      {
        $set: {
          metaCalling: defaultMetaCalling(),
          'calling.status': 'unavailable',
          'calling.unavailableReason': 'provider_unsupported',
          'calling.syncedAt': nowOf(ctx),
          'calling.lastError': "The WhatsApp partner doesn't support calling on this number",
        },
      },
    );
    const updated = await reload(channel._id);
    await audit(updated, 'whatsapp.meta_calling_disabled', actor, {
      turnedOffAtWhatsApp: turnedOff,
      unsubscribed,
      ...(options.byAdmin ? { byAdmin: true } : {}),
    });
    await changed(updated);
    return { channel: updated, turnedOffAtWhatsApp: turnedOff, unsubscribed };
  };

  /**
   * Check (and with `fix`, repair) a number's Meta calling: token still valid and sees the
   * number, webhook subscribed with `calls`, call settings read. `on` ↔ `error`; the bell
   * rings once when it breaks.
   */
  const runCheck = async (
    channel: WhatsAppChannelDoc,
    actor: WaActor,
    options: { fix: boolean; audit: boolean; byAdmin?: boolean },
  ) => {
    const before = stateOf(channel).status;
    const steps: MetaCallingStep[] = [];
    const token = tokenOf(channel);
    let failed: { step: string; code: string; text: string } | null = null;
    if (!token) {
      failed = {
        step: 'token',
        code: 'token_missing',
        text: 'No Meta access for calls on this number — turn calling on again',
      };
      steps.push({ key: 'token', ok: false, detail: failed.text });
    } else {
      steps.push({ key: 'token', ok: true, detail: null });
      try {
        const info = await verify(channel, token);
        steps.push({ key: 'verify', ok: true, detail: null });
        await WhatsAppChannelModel.updateOne(
          { _id: channel._id },
          {
            $set: {
              'metaCalling.tokenExpiresAt': info.expiresAt,
              'metaCalling.scopes': info.scopes,
            },
          },
        );
        const result = await finish(channel, token, steps, { fix: options.fix, turnOn: false });
        if (!result.ok) {
          failed = {
            step: result.failedStep ?? 'webhook',
            code: 'step_failed',
            text: result.error ?? 'Failed',
          };
        }
      } catch (err) {
        const invalid =
          (isMetaApiError(err) && err.tokenInvalid) ||
          (err instanceof AppError && err.code === 'WHATSAPP_SIGNUP_FAILED');
        const lost =
          err instanceof AppError &&
          (err.code === 'WHATSAPP_META_CALLING_MISMATCH' ||
            err.code === 'WHATSAPP_META_CALLING_SCOPES');
        failed = {
          step: 'verify',
          code: invalid ? 'token_invalid' : lost ? 'access_lost' : 'check_failed',
          text: invalid
            ? 'Meta no longer accepts the access for calls on this number'
            : lost
              ? 'The Meta access no longer covers this WhatsApp account or number'
              : message(err),
        };
        steps.push({ key: 'verify', ok: false, detail: failed.text });
      }
    }
    const now = nowOf(ctx);
    if (failed) {
      await fail(channel, failed.step, failed.code, failed.text);
    } else {
      await WhatsAppChannelModel.updateOne(
        { _id: channel._id },
        {
          $set: {
            'metaCalling.status': 'on',
            'metaCalling.checkedAt': now,
            'metaCalling.error': null,
          },
        },
      );
    }
    const updated = await reload(channel._id);
    const after = stateOf(updated).status;
    if (before !== 'error' && after === 'error') await noteMetaCallingBroken(ctx, updated);
    if (options.audit) {
      await audit(updated, 'whatsapp.meta_calling_checked', actor, {
        ok: !failed,
        ...(failed ? { step: failed.step, reason: failed.code } : {}),
        ...(options.byAdmin ? { byAdmin: true } : {}),
      });
    }
    if (before !== after || options.audit) await changed(updated);
    return { channel: updated, steps };
  };

  /** `POST /whatsapp/channels/:id/meta-calling/check` — Check / Fix (6 / 10 min / number). */
  const check = async (
    accountId: Types.ObjectId,
    id: string,
    actor: WaActor,
    options: { byAdmin?: boolean } = {},
  ) => {
    const channel = await load(accountId, id);
    guard(channel);
    if (stateOf(channel).status === 'off') {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'Calls over Meta direct are off on this number — turn them on first.',
      );
    }
    await rateLimit(id);
    return runCheck(channel, actor, {
      fix: true,
      audit: true,
      ...(options.byAdmin ? { byAdmin: true } : {}),
    });
  };

  /** Daily (with the calling settings sync): every number with Meta calling on / broken. */
  const sweep = async (actor: WaActor): Promise<{ checked: number; broken: number }> => {
    if (!ctx.env.WA_META_CALLING_ENABLED) return { checked: 0, broken: 0 };
    const rows = await WhatsAppChannelModel.find({
      provider: 'pinnacle',
      status: { $ne: 'disconnected' },
      'metaCalling.status': { $in: ['on', 'error'] },
    })
      .select(SELECT)
      .lean<WhatsAppChannelDoc[]>();
    let broken = 0;
    for (const channel of rows) {
      try {
        const r = await runCheck(channel, actor, { fix: false, audit: false });
        if (stateOf(r.channel).status === 'error') broken += 1;
      } catch (err) {
        log().warn(
          { channelId: channel._id.toString(), errName: (err as Error).name },
          'meta calling: daily check failed',
        );
      }
    }
    return { checked: rows.length, broken };
  };

  /** The last state (no Meta call, never the token). */
  const status = async (accountId: Types.ObjectId, id: string) =>
    metaCallingJson(stateOf(await load(accountId, id)));

  return { enable, disable, check, sweep, status };
};
export type MetaCallingService = ReturnType<typeof createMetaCallingService>;
