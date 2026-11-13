import { randomBytes, randomInt } from 'node:crypto';

import { Types } from 'mongoose';

import { WHATSAPP_LIMITS } from '../../config/limits';
import {
  isMetaApiError,
  META_ERROR_CODES,
  REQUIRED_META_SCOPES,
  type MetaDebugToken,
  type MetaPhone,
  type MetaPhoneSummary,
  type MetaWaba,
  type PinnacleClient,
} from '../../core/meta';
import { isDuplicateKeyError } from '../../db/errors';
import { AccountModel, DEFAULT_ACCOUNT_WHATSAPP } from '../../db/models/account.model';
import { MetaWebhookEventModel } from '../../db/models/meta-webhook-event.model';
import {
  CONNECT_STEPS,
  WA_ACTIVE_STATUSES,
  WhatsAppChannelModel,
  type ConnectStep,
  type MetaPayer,
  type WaMode,
  type WaStatusReason,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';

import { setupBilling } from './billing-setup';
import {
  canRegister,
  channelDetail,
  channelListItem,
  REGISTER_REASON_CODES,
  type ChannelEvents24h,
} from './channel-json';
import {
  auditChannel,
  emitChannelUpdated,
  markNeedsReconnect,
  notifyChannel,
  notifyDetailChanges,
  numberName,
  PARTNER_CREDIT_LINE_PENDING,
  PROVIDER_KEY_INVALID,
  PROVIDER_NUMBER_MISSING,
  PROVIDER_WEBHOOK_MISMATCH,
  REGISTER_AT_PARTNER,
  TOKEN_INVALID_REASON,
  transition,
  type WaActor,
} from './channel-status';
import { canRetryCoexistence, requestCoexistenceSyncs } from './coexistence';
import {
  clientFor,
  isPinnacle,
  nowOf,
  openSecret,
  phoneLast4,
  sealSecret,
  toE164,
  type WhatsAppContext,
} from './context';
import { metaApiError, notReady, signupError, signupFailed } from './errors';
import { PINNACLE_SECRET_HEADER, pinnacleWebhookUrl } from './pinnacle-webhooks.service';
import { noteProviderError } from './provider-alerts';
import { resetManagedNumbersCache } from './webhooks.service';

const SECRET_FIELDS = '+tokenSealed +registration.pinSealed +pinnacle.webhookSecretSealed';
/** Fields the `phone` step sets (dropped when the number turns out to be taken). */
const PHONE_KEYS = ['phoneNumberId', 'displayPhoneNumber', 'phoneE164', 'verifiedName'] as const;

export interface ConnectInput {
  accountId: Types.ObjectId;
  actor: WaActor;
  mode: WaMode;
  sessionInfo?:
    | {
        wabaId?: string | undefined;
        phoneNumberId?: string | undefined;
        waacId?: string | undefined;
      }
    | undefined;
  /** Embedded Signup code (exchanged for the business token). */
  code?: string;
  /** Superadmin manual connect: an existing System User token instead of a code. */
  accessToken?: string;
  /** Manual connect names the WABA / number directly. */
  manual?: boolean;
}

export type ChannelOutcome = 'connected' | 'action_needed' | 'needs_reconnect';

export interface ConnectResult {
  channel: ReturnType<typeof channelListItem>;
  outcome: ChannelOutcome;
  reconnected: boolean;
}

interface SetupRun {
  channel: WhatsAppChannelDoc;
  attached: boolean;
  registered: boolean;
}

const outcomeOf = (channel: WhatsAppChannelDoc): ChannelOutcome =>
  channel.status === 'connected'
    ? 'connected'
    : channel.status === 'needs_reconnect'
      ? 'needs_reconnect'
      : 'action_needed';

const reason = (code: string, message: string, step: ConnectStep | null): WaStatusReason => ({
  code,
  message: message.slice(0, 300),
  step,
});

const NO_PHONE = reason(
  'no_phone_number',
  'Add a phone number in WhatsApp Manager, then Sync.',
  'phone',
);
const SEVERAL_PHONES = reason(
  'pick_number',
  'This WhatsApp account has several numbers — connect again and pick one in the Meta popup.',
  'phone',
);
const IN_USE = reason(
  'number_in_use',
  'This number is already connected to another account.',
  'phone',
);
const PIN_REQUIRED = reason(
  'pin_required',
  'Two-step verification PIN is already set on this number — enter it to finish.',
  'register',
);

/** Phone fields from Meta (details step / sync). */
const phonePatch = (phone: MetaPhone): Partial<WhatsAppChannelDoc> => ({
  displayPhoneNumber: phone.displayPhoneNumber,
  phoneE164: toE164(phone.displayPhoneNumber),
  verifiedName: phone.verifiedName,
  nameStatus: phone.nameStatus,
  newNameStatus: phone.newNameStatus,
  qualityRating: phone.qualityRating,
  messagingLimitTier: phone.messagingLimitTier,
  codeVerificationStatus: phone.codeVerificationStatus,
  platformType: phone.platformType,
  throughputLevel: phone.throughputLevel,
  accountMode: phone.accountMode,
  phoneStatus: phone.status,
  isOfficialBusinessAccount: phone.isOfficialBusinessAccount,
  isOnBizApp: phone.isOnBizApp,
  messageClassificationKnown: phone.isOnBizAppKnown === true,
  mode: phone.isOnBizApp ? 'coexistence' : 'cloud_api',
});

const wabaPatch = (waba: MetaWaba): Partial<WhatsAppChannelDoc> => ({
  wabaName: waba.name,
  businessId: waba.businessId,
  businessName: waba.businessName,
  wabaCurrency: waba.currency,
  wabaTimezoneId: waba.timezoneId,
  templateNamespace: waba.templateNamespace,
  wabaReviewStatus: waba.reviewStatus,
  businessVerificationStatus: waba.businessVerificationStatus,
});

const tokenPatch = (info: MetaDebugToken, now: Date): Partial<WhatsAppChannelDoc> => ({
  tokenType: info.type,
  tokenScopes: info.scopes,
  tokenExpiresAt: info.expiresAt,
  tokenCheckedAt: now,
  metaUserId: info.userId,
});

/** Where a retry / sync continues a setup. */
const resumeStep = (channel: WhatsAppChannelDoc): ConnectStep =>
  channel.statusReason?.step ?? (channel.phoneNumberId ? 'details' : 'phone');

/** Phone statuses that mean Meta restricted the number. */
const RESTRICTED_PHONE_STATUSES = new Set(['BANNED', 'RESTRICTED']);

/**
 * WhatsApp channels (PHASE_9_PLAN §1d / §1g / §1h): Embedded Signup connect, setup
 * retry, PIN, sync, rename, disconnect, views. Secrets stay sealed in the database
 * and never leave this module except through `getChannelToken` (server-side use).
 */
/** Optional effects of the service (Phase 11: a template sync after a successful connect). */
export interface WhatsAppServiceHooks {
  onConnected?: (channel: WhatsAppChannelDoc) => Promise<void>;
}

export const createWhatsAppService = (ctx: WhatsAppContext, hooks: WhatsAppServiceHooks = {}) => {
  const log = () => getLogger();
  /** Never fails the connect: the daily sync catches up. */
  const connected = async (channel: WhatsAppChannelDoc) => {
    if (!hooks.onConnected || !['connected', 'restricted'].includes(channel.status)) return;
    try {
      await hooks.onConnected(channel);
    } catch (err) {
      log().warn(
        { channelId: channel._id.toString(), errName: (err as Error).name },
        'whatsapp: after-connect hook failed',
      );
    }
  };
  const { meta, redis } = ctx;

  // ── locks / rate limits ───────────────────────────────────────────────────
  const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
  const withLock = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const key = `wa-connect-${name}`;
    const owner = randomBytes(8).toString('hex');
    const got = await redis.set(key, owner, 'PX', WHATSAPP_LIMITS.connectLockTtlMs, 'NX');
    if (got !== 'OK') {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'This number is being connected right now — try again in a minute.',
      );
    }
    try {
      return await fn();
    } finally {
      await redis.eval(RELEASE, 1, key, owner);
    }
  };

  const rateLimit = async (name: string, message: string) => {
    const key = `wa-rl-${name}`;
    const ok = await redis.set(key, '1', 'EX', 60 / WHATSAPP_LIMITS.syncPerMinutePerChannel, 'NX');
    if (ok === 'OK') return;
    const ttl = await redis.ttl(key);
    throw new AppError('RATE_LIMITED', message, undefined, { retryAfterSec: Math.max(ttl, 1) });
  };

  // ── loading ───────────────────────────────────────────────────────────────
  const load = async (accountId: Types.ObjectId, id: string, secrets = false) => {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundError('WhatsApp number not found');
    const query = WhatsAppChannelModel.findOne({ _id: id, accountId });
    if (secrets) query.select(SECRET_FIELDS);
    const channel = await query.lean<WhatsAppChannelDoc>();
    if (!channel) throw new NotFoundError('WhatsApp number not found');
    return channel;
  };

  const tokenOf = (channel: WhatsAppChannelDoc): string | null => {
    if (!channel.tokenSealed) return null;
    try {
      return openSecret(ctx, channel.tokenSealed);
    } catch {
      log().error({ channelId: channel._id.toString() }, 'whatsapp: token could not be opened');
      return null;
    }
  };

  const activeElsewhere = (phoneNumberId: string, exceptId: Types.ObjectId | null) =>
    WhatsAppChannelModel.findOne({
      phoneNumberId,
      status: { $in: WA_ACTIVE_STATUSES },
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    })
      .select({ accountId: 1 })
      .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId }>();

  /** PIN for registering a number: `WHATSAPP_REGISTER_PIN`, else a random one. */
  const registerPinOf = (): string =>
    ctx.env.WHATSAPP_REGISTER_PIN ??
    String(randomInt(0, 1_000_000)).padStart(WHATSAPP_LIMITS.pinLength, '0');

  // ── Meta lookups for a signup ─────────────────────────────────────────────
  const resolveWaba = async (
    token: string,
    granted: string[],
    hint: string | undefined,
  ): Promise<string> => {
    if (hint && granted.includes(hint)) return hint;
    if (hint && granted.length) {
      throw signupFailed(
        'waba',
        "The WhatsApp Business Account from the popup wasn't shared with this app.",
      );
    }
    if (granted.length === 1 && granted[0]) return granted[0];
    // Discovery is best effort: Meta answers #100 ("nonexisting field") for
    // `me/whatsapp_business_accounts` on some tokens, and `me/businesses` needs
    // business_management. A lookup that fails only means "found nothing here".
    const discover = async (lookup: () => Promise<string[]>): Promise<string[]> => {
      try {
        return await lookup();
      } catch (err) {
        if (!isMetaApiError(err) || err.tokenInvalid) throw err;
        log().warn({ code: err.code }, 'whatsapp: WABA discovery lookup failed');
        return [];
      }
    };
    // meta-only: embedded signup
    let candidates = await discover(async () =>
      (await meta.listOwnedWabas(token)).map((w) => w.id),
    );
    if (!candidates.length) {
      candidates = await discover(async () =>
        // meta-only: embedded signup
        (await meta.listBusinessesWithWabas(token)).flatMap((b) => b.wabas.map((w) => w.id)),
      );
    }
    if (granted.length) candidates = candidates.filter((id) => granted.includes(id));
    candidates = [...new Set(candidates)];
    if (hint && candidates.includes(hint)) return hint;
    // nothing could be listed: trust the popup's WABA (its details are read next,
    // which fails cleanly when this app has no access to it)
    if (hint && !candidates.length && !granted.length) return hint;
    if (candidates.length === 1 && candidates[0]) return candidates[0];
    throw signupFailed(
      'waba',
      candidates.length
        ? 'Several WhatsApp Business Accounts were shared — connect again and pick one.'
        : 'No WhatsApp Business Account was shared.',
    );
  };

  /** `null` = the WABA has no number yet; `'several'` = can't choose without a hint. */
  const pickPhone = (
    phones: MetaPhoneSummary[],
    hint: string | undefined,
  ): MetaPhoneSummary | null | 'several' | 'not_found' => {
    if (hint) return phones.find((p) => p.id === hint) ?? 'not_found';
    if (phones.length === 1 && phones[0]) return phones[0];
    return phones.length ? 'several' : null;
  };

  const accountPayer = async (accountId: Types.ObjectId): Promise<MetaPayer> => {
    const account = await AccountModel.findById(accountId)
      .select({ whatsapp: 1 })
      .lean<{ whatsapp?: { metaPayer?: MetaPayer } }>();
    return account?.whatsapp?.metaPayer ?? DEFAULT_ACCOUNT_WHATSAPP.metaPayer;
  };

  // ── setup steps (details → subscribe → billing → register) ───────────────
  const runSetup = async (
    channel: WhatsAppChannelDoc,
    token: string,
    from: ConnectStep,
    actor: WaActor,
  ): Promise<SetupRun> => {
    let ch = channel;
    let patch: Partial<WhatsAppChannelDoc> = {};
    const apply = (p: Partial<WhatsAppChannelDoc>) => {
      patch = { ...patch, ...p };
      ch = { ...ch, ...p };
    };
    let attached = false;
    let registered = false;
    let waba: MetaWaba | null = null;
    let step: ConnectStep = from;
    let fail: WaStatusReason | null = null;
    const now = nowOf(ctx);
    try {
      for (step of CONNECT_STEPS.slice(CONNECT_STEPS.indexOf(from))) {
        if (step === 'phone') {
          const picked = pickPhone(
            await clientFor(ctx, ch).listPhoneNumbers(token, ch.wabaId),
            undefined,
          );
          if (picked === null || picked === 'not_found') fail = NO_PHONE;
          else if (picked === 'several') fail = SEVERAL_PHONES;
          else if (await activeElsewhere(picked.id, ch._id)) fail = IN_USE;
          else
            apply({
              phoneNumberId: picked.id,
              displayPhoneNumber: picked.displayPhoneNumber,
              phoneE164: toE164(picked.displayPhoneNumber),
              verifiedName: picked.verifiedName,
            });
        } else if (step === 'details') {
          waba = await clientFor(ctx, ch).getWaba(token, ch.wabaId);
          apply({
            ...wabaPatch(waba),
            ...phonePatch(await clientFor(ctx, ch).getPhoneNumber(token, ch.phoneNumberId ?? '')),
          });
        } else if (step === 'subscribe') {
          try {
            // meta-only: our app's webhook subscription (never for managed numbers)
            await meta.subscribeApp(token, ch.wabaId);
            apply({ subscription: { status: 'subscribed', error: null, at: now } });
          } catch (err) {
            if (!isMetaApiError(err) || err.tokenInvalid) throw err;
            apply({
              subscription: { status: 'failed', error: err.message.slice(0, 300), at: now },
            });
            fail = reason(
              'subscribe_failed',
              "Couldn't subscribe this app to the WhatsApp account's events — Retry setup.",
              'subscribe',
            );
          }
        } else if (step === 'billing') {
          // until a credit line is attached, the account setting decides (a superadmin
          // may switch a failing account to "customer pays Meta" before Retry setup)
          if (ch.creditLine.status !== 'attached')
            apply({ metaPayer: await accountPayer(ch.accountId) });
          waba ??= await clientFor(ctx, ch).getWaba(token, ch.wabaId);
          const billing = await setupBilling(ctx, ch, token, waba);
          apply(billing.patch);
          attached = billing.attached;
          fail = billing.fail ?? null;
        } else if (ch.mode === 'coexistence') {
          apply({ registration: { ...ch.registration, status: 'not_needed', error: null } });
          apply({ coexistence: await requestCoexistenceSyncs(ctx, ch, token) });
        } else if (ch.registration.status !== 'registered') {
          if (ch.phoneStatus === 'CONNECTED') {
            apply({ registration: { ...ch.registration, status: 'not_needed', error: null } });
          } else {
            const pin = registerPinOf();
            try {
              await clientFor(ctx, ch).registerPhone(token, ch.phoneNumberId ?? '', pin);
              apply({
                registration: {
                  status: 'registered',
                  pinSealed: sealSecret(ctx, pin),
                  error: null,
                  at: now,
                },
                phoneStatus: 'CONNECTED',
              });
              registered = true;
            } catch (err) {
              if (!isMetaApiError(err) || err.tokenInvalid) throw err;
              const pinNeeded = err.code === META_ERROR_CODES.pinMismatch;
              apply({
                registration: {
                  ...ch.registration,
                  status: pinNeeded ? 'pending' : 'failed',
                  error: err.message.slice(0, 300),
                },
              });
              fail = pinNeeded
                ? PIN_REQUIRED
                : reason(
                    'register_failed',
                    `Meta couldn't register the number: ${err.message}`,
                    'register',
                  );
            }
          }
        }
        if (fail) break;
      }
    } catch (err) {
      if (isMetaApiError(err) && err.tokenInvalid) {
        const updated = await markNeedsReconnect(ctx, ch, TOKEN_INVALID_REASON, actor);
        return { channel: await persist(updated, patch), attached, registered };
      }
      fail = isMetaApiError(err)
        ? reason('meta_error', `Meta returned an error: ${err.message}`, step)
        : reason('setup_error', 'Setup stopped unexpectedly — Retry setup.', step);
      if (!isMetaApiError(err)) {
        await saveOutcome(ch, patch, fail, actor);
        throw err;
      }
    }
    return { channel: await saveOutcome(ch, patch, fail, actor), attached, registered };
  };

  /** Writes fields gathered after a status change that already happened. */
  const persist = async (channel: WhatsAppChannelDoc, patch: Partial<WhatsAppChannelDoc>) => {
    if (!Object.keys(patch).length) return channel;
    const updated = await WhatsAppChannelModel.findOneAndUpdate(
      { _id: channel._id },
      { $set: patch },
      { returnDocument: 'after' },
    ).lean<WhatsAppChannelDoc>();
    return updated ?? channel;
  };

  const saveOutcome = async (
    ch: WhatsAppChannelDoc,
    patch: Partial<WhatsAppChannelDoc>,
    fail: WaStatusReason | null,
    actor: WaActor,
  ): Promise<WhatsAppChannelDoc> => {
    const extra = { ...patch, syncedAt: nowOf(ctx) };
    try {
      if (!fail) return await transition(ctx, ch, 'connected', null, actor, extra);
      const updated = await transition(ctx, ch, 'action_needed', fail, actor, extra);
      await auditChannel(updated, 'whatsapp.channel_setup_failed', actor, {
        step: fail.step,
        reasonCode: fail.code,
      });
      return updated;
    } catch (err) {
      // the number was connected elsewhere between the check and the save
      if (!isDuplicateKeyError(err) || fail === IN_USE) throw err;
      const rest = { ...patch };
      for (const key of PHONE_KEYS) delete rest[key];
      return saveOutcome(ch, rest, IN_USE, actor);
    }
  };

  const afterSetupAudits = async (run: SetupRun, actor: WaActor) => {
    if (run.attached) {
      await auditChannel(run.channel, 'whatsapp.credit_line_attached', actor, {
        metaPayer: run.channel.metaPayer,
      });
    }
    if (run.registered) await auditChannel(run.channel, 'whatsapp.channel_registered', actor);
  };

  // ── connect ───────────────────────────────────────────────────────────────
  const connect = async (input: ConnectInput): Promise<ConnectResult> => {
    const account = await AccountModel.findById(input.accountId)
      .select({ whatsapp: 1 })
      .lean<{ whatsapp?: { metaPayer?: MetaPayer } }>();
    if (!account) throw new NotFoundError('Account not found');
    const metaPayer = account.whatsapp?.metaPayer ?? DEFAULT_ACCOUNT_WHATSAPP.metaPayer;

    let token: string;
    let info: MetaDebugToken;
    try {
      // meta-only: embedded signup
      token = input.accessToken ?? (await meta.exchangeCode(input.code ?? '')).accessToken;
    } catch (err) {
      throw signupError(err, 'exchange');
    }
    try {
      // meta-only: embedded signup
      info = await meta.debugToken(token);
    } catch (err) {
      throw signupError(err, 'verify');
    }
    if (!info.isValid)
      throw signupFailed('verify', "Meta didn't confirm access to WhatsApp — try again.");
    const missing = REQUIRED_META_SCOPES.filter((s) => !info.scopes.includes(s));
    if (missing.length) {
      throw signupFailed(
        'verify',
        'The WhatsApp permissions were not granted — connect again and allow every permission in the Meta popup.',
      );
    }

    let wabaId: string;
    let picked: MetaPhoneSummary | null;
    try {
      wabaId = await resolveWaba(token, info.grantedWabaIds, input.sessionInfo?.wabaId);
      const choice = pickPhone(
        // meta-only: embedded signup
        await meta.listPhoneNumbers(token, wabaId),
        input.sessionInfo?.phoneNumberId,
      );
      if (choice === 'not_found') {
        throw signupFailed(
          'phone',
          "The phone number from the popup isn't in that WhatsApp Business Account.",
        );
      }
      if (choice === 'several') {
        throw signupFailed(
          'phone',
          'This WhatsApp account has several numbers — connect again and pick one.',
        );
      }
      picked = choice;
    } catch (err) {
      throw signupError(err, 'waba');
    }

    return withLock(picked?.id ?? `waba-${wabaId}`, async () => {
      const now = nowOf(ctx);
      const active = picked
        ? await WhatsAppChannelModel.findOne({
            phoneNumberId: picked.id,
            status: { $in: WA_ACTIVE_STATUSES },
          }).lean<WhatsAppChannelDoc>()
        : await WhatsAppChannelModel.findOne({
            accountId: input.accountId,
            wabaId,
            phoneNumberId: null,
            status: { $in: WA_ACTIVE_STATUSES },
          }).lean<WhatsAppChannelDoc>();
      if (active && !active.accountId.equals(input.accountId)) {
        throw new AppError('WHATSAPP_NUMBER_IN_USE');
      }
      const reuse =
        active ??
        (picked
          ? await WhatsAppChannelModel.findOne({
              accountId: input.accountId,
              phoneNumberId: picked.id,
              status: 'disconnected',
            })
              .sort({ updatedAt: -1 })
              .lean<WhatsAppChannelDoc>()
          : null);
      if (!active) {
        const count = await WhatsAppChannelModel.countDocuments({
          accountId: input.accountId,
          status: { $in: WA_ACTIVE_STATUSES },
        });
        if (count >= WHATSAPP_LIMITS.maxChannelsPerAccount)
          throw new AppError('WHATSAPP_CHANNEL_LIMIT');
      }
      const base: Partial<WhatsAppChannelDoc> = {
        provider: meta.provider,
        mode: input.mode,
        wabaId,
        // Meta named the WhatsApp account apart: wabaId is then the Messaging account
        ...(input.sessionInfo?.waacId
          ? { waacId: input.sessionInfo.waacId, wabaKind: 'messaging' as const }
          : {}),
        phoneNumberId: picked?.id ?? null,
        displayPhoneNumber: picked?.displayPhoneNumber ?? null,
        phoneE164: toE164(picked?.displayPhoneNumber),
        verifiedName: picked?.verifiedName ?? null,
        tokenSealed: sealSecret(ctx, token),
        ...tokenPatch(info, now),
        // a credit line can't be removed from a WABA: keep the payer once attached
        metaPayer: reuse?.creditLine.status === 'attached' ? reuse.metaPayer : metaPayer,
        connectedBy: input.actor.id,
        connectedAt: now,
        disconnectedBy: null,
        disconnectedAt: null,
      };
      let channel: WhatsAppChannelDoc;
      if (reuse) {
        channel = await transition(ctx, reuse, 'connecting', null, input.actor, base);
      } else {
        try {
          const created = await WhatsAppChannelModel.create({
            ...base,
            accountId: input.accountId,
            label: (picked?.verifiedName ?? picked?.displayPhoneNumber ?? 'WhatsApp number').slice(
              0,
              WHATSAPP_LIMITS.labelMax,
            ),
            status: 'connecting',
            history: [{ status: 'connecting', reason: null, at: now, by: input.actor.id }],
          });
          channel = created.toObject({ transform: false });
          emitChannelUpdated(channel);
        } catch (err) {
          if (!isDuplicateKeyError(err) || !picked) throw err;
          const holder = await activeElsewhere(picked.id, null);
          if (holder && !holder.accountId.equals(input.accountId))
            throw new AppError('WHATSAPP_NUMBER_IN_USE');
          throw new ConflictError(
            'CONFLICT_INVALID_STATE',
            'This number is being connected right now — try again in a minute.',
          );
        }
      }
      const run = await runSetup(channel, token, picked ? 'details' : 'phone', input.actor);
      await auditChannel(
        run.channel,
        reuse ? 'whatsapp.channel_reconnected' : 'whatsapp.channel_connected',
        input.actor,
        { metaPayer: run.channel.metaPayer, ...(input.manual ? { manual: true } : {}) },
      );
      await afterSetupAudits(run, input.actor);
      await connected(run.channel);
      return {
        channel: channelListItem(run.channel),
        outcome: outcomeOf(run.channel),
        reconnected: Boolean(reuse),
      };
    });
  };

  // ── retry / PIN / sync ────────────────────────────────────────────────────
  const requireToken = async (channel: WhatsAppChannelDoc, actor: WaActor) => {
    const token = tokenOf(channel);
    if (token) return token;
    await markNeedsReconnect(ctx, channel, TOKEN_INVALID_REASON, actor);
    throw notReady('Reconnect this WhatsApp number first.');
  };

  const retrySetup = async (accountId: Types.ObjectId, id: string, actor: WaActor) => {
    const channel = await load(accountId, id, true);
    if (channel.status !== 'action_needed') {
      throw new ConflictError('CONFLICT_INVALID_STATE', 'This number has no setup step to retry.');
    }
    // PN (D18): a managed number has no setup steps here — check it at the partner again
    if (isPinnacle(channel)) {
      const synced = await syncManaged(channel, actor);
      await connected(synced);
      return { channel: channelListItem(synced), outcome: outcomeOf(synced) };
    }
    const token = await requireToken(channel, actor);
    const run = await withLock(channel.phoneNumberId ?? `waba-${channel.wabaId}`, () =>
      runSetup(channel, token, resumeStep(channel), actor),
    );
    await afterSetupAudits(run, actor);
    await connected(run.channel);
    return { channel: channelListItem(run.channel), outcome: outcomeOf(run.channel) };
  };

  /**
   * "Register number" (and the PIN form): registers the number on the Cloud API — at
   * Meta, or through the partner for a managed number. Without a PIN the configured
   * one (`WHATSAPP_REGISTER_PIN`) is used; a number that already asked for its PIN
   * needs it typed in when none is configured.
   */
  const submitPin = async (
    accountId: Types.ObjectId,
    id: string,
    pinInput: string | undefined,
    actor: WaActor,
  ) => {
    const channel = await load(accountId, id, true);
    if (!canRegister(channel)) {
      throw new ConflictError('CONFLICT_INVALID_STATE', "This number doesn't need registering.");
    }
    const pin =
      pinInput ??
      ctx.env.WHATSAPP_REGISTER_PIN ??
      (channel.statusReason?.code === PIN_REQUIRED.code ? null : registerPinOf());
    if (!pin) {
      throw new ValidationError([
        { path: 'pin', message: 'Enter the 6-digit two-step verification PIN.' },
      ]);
    }
    const managedNumber = isPinnacle(channel);
    let token: string;
    if (managedNumber) {
      const key = tokenOf(channel);
      if (!key) {
        await markNeedsReconnect(ctx, channel, PROVIDER_KEY_INVALID, actor);
        throw notReady('The partner API key for this number is missing — contact support.');
      }
      token = key;
    } else {
      token = await requireToken(channel, actor);
    }
    return withLock(channel.phoneNumberId ?? `waba-${channel.wabaId}`, async () => {
      try {
        await clientFor(ctx, channel).registerPhone(token, channel.phoneNumberId ?? '', pin);
      } catch (err) {
        if (!isMetaApiError(err)) throw err;
        if (err.tokenInvalid) {
          await markNeedsReconnect(
            ctx,
            channel,
            managedNumber ? PROVIDER_KEY_INVALID : TOKEN_INVALID_REASON,
            actor,
          );
          throw notReady(
            managedNumber
              ? 'The partner API key for this number was rejected — contact support.'
              : 'Reconnect this WhatsApp number first.',
          );
        }
        if (err.code === META_ERROR_CODES.pinMismatch) {
          // remember that this number wants its own PIN (the form asks for it next)
          if (channel.status === 'action_needed' || channel.phoneStatus !== 'CONNECTED') {
            await transition(ctx, channel, 'action_needed', PIN_REQUIRED, actor, {
              registration: {
                ...channel.registration,
                status: 'pending',
                error: err.message.slice(0, 300),
              },
            });
          }
          throw new ValidationError([
            {
              path: 'pin',
              message: "That PIN doesn't match the number's two-step verification PIN.",
            },
          ]);
        }
        if (managedNumber) await noteProviderError(ctx, channel._id, err);
        throw metaApiError(err);
      }
      const now = nowOf(ctx);
      const waitedForRegistration = REGISTER_REASON_CODES.has(channel.statusReason?.code ?? '');
      const next = !waitedForRegistration
        ? { status: channel.status, why: channel.statusReason ?? null }
        : managedNumber
          ? managedState(channel, 'CONNECTED', true)
          : { status: 'connected' as const, why: null };
      const updated = await transition(ctx, channel, next.status, next.why, actor, {
        registration: {
          status: 'registered',
          pinSealed: sealSecret(ctx, pin),
          error: null,
          at: now,
        },
        phoneStatus: 'CONNECTED',
        syncedAt: now,
      });
      await auditChannel(updated, 'whatsapp.channel_registered', actor, { manual: true });
      await connected(updated);
      return { channel: channelListItem(updated), outcome: outcomeOf(updated) };
    });
  };

  /**
   * One health pass (also the daily job): token check, Meta details, status.
   * `action_needed` channels resume their setup. Never throws Meta errors for
   * token problems — the channel moves to `needs_reconnect` instead.
   */
  const syncChannel = async (
    channel: WhatsAppChannelDoc,
    actor: WaActor,
  ): Promise<WhatsAppChannelDoc> => {
    if (channel.status === 'disconnected') throw notReady('This WhatsApp number is disconnected.');
    // PN (D17): a managed number is checked at the partner, not with Meta's debug_token
    if (isPinnacle(channel)) return syncManaged(channel, actor);
    const token = tokenOf(channel);
    if (!token) return markNeedsReconnect(ctx, channel, TOKEN_INVALID_REASON, actor);
    const now = nowOf(ctx);
    try {
      // meta-only: Meta numbers' token check (managed numbers: see the Pinnacle branch)
      const info = await meta.debugToken(token);
      if (!info.isValid) return await markNeedsReconnect(ctx, channel, TOKEN_INVALID_REASON, actor);
      if (info.grantedWabaIds.length && !info.grantedWabaIds.includes(channel.wabaId)) {
        return await markNeedsReconnect(
          ctx,
          channel,
          reason(
            'access_removed',
            'Access to this WhatsApp account was removed — reconnect the number.',
            null,
          ),
          actor,
        );
      }
      const ch: WhatsAppChannelDoc = { ...channel, ...tokenPatch(info, now) };
      if (ch.status === 'action_needed' || ch.status === 'connecting') {
        const run = await runSetup(ch, token, resumeStep(ch), actor);
        await afterSetupAudits(run, actor);
        return run.channel;
      }
      const waba = await clientFor(ctx, ch).getWaba(token, ch.wabaId);
      const phone = await clientFor(ctx, ch).getPhoneNumber(token, ch.phoneNumberId ?? '');
      const patch: Partial<WhatsAppChannelDoc> = {
        ...tokenPatch(info, now),
        ...wabaPatch(waba),
        ...phonePatch(phone),
        ...(ch.metaPayer === 'customer' ? { paymentMethodOk: Boolean(waba.primaryFundingId) } : {}),
        syncedAt: now,
      };
      const synced = async (updated: Promise<WhatsAppChannelDoc>) => {
        const after = await updated;
        await notifyDetailChanges(ctx, channel, after);
        return after;
      };
      if (RESTRICTED_PHONE_STATUSES.has(phone.status ?? '')) {
        return await synced(
          transition(
            ctx,
            ch,
            'restricted',
            reason(
              'restricted',
              `Meta reports this number as ${(phone.status ?? '').toLowerCase()}.`,
              null,
            ),
            actor,
            {
              ...patch,
              restriction: ch.restriction ?? { type: phone.status ?? 'RESTRICTED', until: null },
            },
          ),
        );
      }
      // a restriction Meta reported by phone status ends when the number is fine again;
      // one from a webhook lasts until its end date or until a webhook lifts it
      const restrictionActive = ch.restriction?.until
        ? ch.restriction.until > now
        : Boolean(ch.restriction) && !RESTRICTED_PHONE_STATUSES.has(ch.restriction?.type ?? '');
      if (ch.status === 'restricted' && restrictionActive) {
        return await synced(transition(ctx, ch, 'restricted', ch.statusReason, actor, patch));
      }
      return await synced(
        transition(ctx, ch, 'connected', null, actor, { ...patch, restriction: null }),
      );
    } catch (err) {
      if (isMetaApiError(err) && err.tokenInvalid) {
        return markNeedsReconnect(ctx, channel, TOKEN_INVALID_REASON, actor);
      }
      throw isMetaApiError(err) ? metaApiError(err) : err;
    }
  };

  const sync = async (accountId: Types.ObjectId, id: string, actor: WaActor) => {
    const channel = await load(accountId, id, true);
    await rateLimit(
      `sync-${id}`,
      'This number was synced less than a minute ago — try again shortly.',
    );
    const updated = await syncChannel(channel, actor);
    return { channel: channelListItem(updated), outcome: outcomeOf(updated) };
  };

  const retryCoexistenceSync = async (accountId: Types.ObjectId, id: string, actor: WaActor) => {
    const channel = await load(accountId, id, true);
    if (channel.status !== 'connected' || !canRetryCoexistence(channel)) {
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'There is no WhatsApp Business app sync to retry.',
      );
    }
    await rateLimit(
      `coex-${id}`,
      'A sync was requested less than a minute ago — try again shortly.',
    );
    const token = await requireToken(channel, actor);
    try {
      const coexistence = await requestCoexistenceSyncs(ctx, channel, token);
      const updated = await transition(ctx, channel, channel.status, channel.statusReason, actor, {
        coexistence,
      });
      return { channel: channelListItem(updated) };
    } catch (err) {
      if (isMetaApiError(err) && err.tokenInvalid) {
        await markNeedsReconnect(ctx, channel, TOKEN_INVALID_REASON, actor);
        throw notReady('Reconnect this WhatsApp number first.');
      }
      throw err;
    }
  };

  // ── rename / disconnect ───────────────────────────────────────────────────
  const rename = async (accountId: Types.ObjectId, id: string, label: string, actor: WaActor) => {
    const channel = await load(accountId, id);
    const updated = await WhatsAppChannelModel.findOneAndUpdate(
      { _id: channel._id, accountId },
      { $set: { label } },
      { returnDocument: 'after' },
    ).lean<WhatsAppChannelDoc>();
    if (!updated) throw new NotFoundError('WhatsApp number not found');
    emitChannelUpdated(updated);
    if (updated.label !== channel.label) {
      await auditChannel(updated, 'whatsapp.channel_renamed', actor, {
        from: channel.label,
        to: updated.label,
      });
    }
    return channelListItem(updated);
  };

  /**
   * Disconnect (§1h): unsubscribe the app from the WABA only when no other active
   * channel (any account) uses it, clear the token and PIN, keep the record. The
   * number is **never deregistered** — the business's WhatsApp keeps working.
   */
  const disconnect = async (
    accountId: Types.ObjectId,
    id: string,
    actor: WaActor,
    options: { byAdminReason?: string } = {},
  ) => {
    const channel = await load(accountId, id, true);
    if (channel.status === 'disconnected') return channelListItem(channel);
    const othersOnWaba = await WhatsAppChannelModel.countDocuments({
      wabaId: channel.wabaId,
      status: { $in: WA_ACTIVE_STATUSES },
      _id: { $ne: channel._id },
    });
    const token = tokenOf(channel);
    if (isPinnacle(channel)) {
      // PN (D20): stop the partner relaying this number to us (best effort)
      if (token && channel.phoneNumberId && ctx.pinnacle) {
        try {
          await ctx.pinnacle.setWebhook(token, channel.phoneNumberId, '', {});
        } catch (err) {
          log().warn(
            { channelId: channel._id.toString(), type: isMetaApiError(err) ? err.type : null },
            'whatsapp: partner webhook not cleared (disconnecting anyway)',
          );
        }
      }
    } else if (!othersOnWaba && token) {
      try {
        // meta-only: our app's webhook subscription
        await meta.unsubscribeApp(token, channel.wabaId);
      } catch (err) {
        log().warn(
          {
            channelId: channel._id.toString(),
            code: isMetaApiError(err) ? err.code : null,
          },
          'whatsapp: unsubscribe failed (disconnecting anyway)',
        );
      }
    }
    const now = nowOf(ctx);
    const why = options.byAdminReason
      ? reason(
          'disconnected_by_admin',
          `Disconnected by the platform team: ${options.byAdminReason}`,
          null,
        )
      : null;
    const updated = await transition(ctx, channel, 'disconnected', why, actor, {
      tokenSealed: null,
      'registration.pinSealed': null,
      ...(isPinnacle(channel) && channel.pinnacle
        ? { 'pinnacle.webhookSecretSealed': null, 'pinnacle.webhookSetAt': null }
        : {}),
      subscription:
        othersOnWaba && !isPinnacle(channel)
          ? channel.subscription
          : { status: null, error: null, at: now },
      disconnectedBy: actor.id,
      disconnectedAt: now,
    });
    if (isPinnacle(channel)) resetManagedNumbersCache();
    await auditChannel(updated, 'whatsapp.channel_disconnected', actor, {
      unsubscribed: !othersOnWaba && !isPinnacle(channel),
      ...(options.byAdminReason ? { byAdmin: true, reason: options.byAdminReason } : {}),
    });
    if (options.byAdminReason) {
      await notifyChannel(
        ctx,
        updated,
        'whatsapp.channel_disconnected_by_admin',
        'WhatsApp number disconnected by the platform team',
        `${numberName(updated)} was disconnected: ${options.byAdminReason}`.slice(0, 500),
        options.byAdminReason,
      );
    }
    return channelListItem(updated);
  };

  // ── PN: managed numbers (Pinnacle partner API) ────────────────────────────
  const pinnacleOf = (): PinnacleClient => {
    if (!ctx.env.PINNACLE_ENABLED || !ctx.pinnacle)
      throw new AppError('WA_PROVIDER_NOT_CONFIGURED');
    return ctx.pinnacle;
  };

  /** A partner error as the API answers it (balance / unsupported / refused / Meta's). */
  const partnerError = (err: unknown): unknown => (isMetaApiError(err) ? metaApiError(err) : err);

  /** The key must be valid and list this number of this WABA. */
  const checkKey = async (
    pin: PinnacleClient,
    apiKey: string,
    wabaId: string,
    phoneNumberId: string,
  ) => {
    let numbers;
    try {
      numbers = await pin.getUserDetails(apiKey);
    } catch (err) {
      if (isMetaApiError(err) && err.tokenInvalid) throw new AppError('PINNACLE_KEY_INVALID');
      throw partnerError(err);
    }
    if (!numbers.some((n) => n.phoneNumberId === phoneNumberId && n.wabaId === wabaId)) {
      throw new AppError('PINNACLE_NUMBER_NOT_ON_KEY');
    }
  };

  /**
   * Does the partner relay this number to our URL with our secret? (The header is checked
   * when the partner echoes headers; some answers leave them out.)
   */
  const webhookMatches = async (
    pin: PinnacleClient,
    apiKey: string,
    channel: Pick<WhatsAppChannelDoc, '_id' | 'phoneNumberId'>,
    secret: string,
  ): Promise<boolean> => {
    const current = await pin.getWebhook(apiKey, channel.phoneNumberId ?? '');
    if (!current || current.url !== pinnacleWebhookUrl(ctx.env, channel._id)) return false;
    const echoed = Object.entries(current.headers).find(
      ([k]) => k.toLowerCase() === PINNACLE_SECRET_HEADER,
    );
    return !echoed || echoed[1] === secret;
  };

  /** `setwebhook` to our URL + secret header, then read it back (D8). */
  const setWebhookChecked = async (
    pin: PinnacleClient,
    apiKey: string,
    channel: Pick<WhatsAppChannelDoc, '_id' | 'phoneNumberId'>,
    secret: string,
  ) => {
    try {
      await pin.setWebhook(
        apiKey,
        channel.phoneNumberId ?? '',
        pinnacleWebhookUrl(ctx.env, channel._id),
        {
          [PINNACLE_SECRET_HEADER]: secret,
        },
      );
      if (await webhookMatches(pin, apiKey, channel, secret)) return;
    } catch (err) {
      if (isMetaApiError(err) && err.tokenInvalid) throw new AppError('PINNACLE_KEY_INVALID');
      throw new AppError(
        'PINNACLE_WEBHOOK_NOT_SET',
        undefined,
        isMetaApiError(err) ? [{ path: 'provider', message: err.message }] : undefined,
        { cause: err },
      );
    }
    throw new AppError('PINNACLE_WEBHOOK_NOT_SET', undefined, [
      { path: 'provider', message: "The partner didn't keep our webhook URL." },
    ]);
  };

  /** Status of a managed number from what the partner reports (D12 / D17 / D18). */
  const managedState = (
    ch: Pick<WhatsAppChannelDoc, 'creditLine' | 'restriction'>,
    phoneStatus: string | null,
    webhookOk: boolean,
  ): { status: WhatsAppChannelDoc['status']; why: WaStatusReason | null } => {
    if (RESTRICTED_PHONE_STATUSES.has(phoneStatus ?? '')) {
      return {
        status: 'restricted',
        why: reason(
          'restricted',
          `Meta reports this number as ${(phoneStatus ?? '').toLowerCase()}.`,
          null,
        ),
      };
    }
    if (!webhookOk) return { status: 'action_needed', why: PROVIDER_WEBHOOK_MISMATCH };
    if (ch.creditLine.status === 'partner_pending') {
      return { status: 'action_needed', why: PARTNER_CREDIT_LINE_PENDING };
    }
    if (phoneStatus && phoneStatus !== 'CONNECTED') {
      return { status: 'action_needed', why: REGISTER_AT_PARTNER };
    }
    return { status: 'connected', why: null };
  };

  const loadManaged = async (channelId: string) => {
    if (!Types.ObjectId.isValid(channelId)) throw new NotFoundError('WhatsApp number not found');
    const channel = await WhatsAppChannelModel.findById(channelId)
      .select(SECRET_FIELDS)
      .lean<WhatsAppChannelDoc>();
    if (!channel) throw new NotFoundError('WhatsApp number not found');
    if (!isPinnacle(channel)) {
      throw new ConflictError('CONFLICT_INVALID_STATE', 'This is not a managed number.');
    }
    if (channel.status === 'disconnected') {
      throw new ConflictError('CONFLICT_INVALID_STATE', 'This number is disconnected.');
    }
    return channel;
  };

  const webhookSecretOf = (channel: WhatsAppChannelDoc): string | null => {
    const sealed = channel.pinnacle?.webhookSecretSealed;
    if (!sealed) return null;
    try {
      return openSecret(ctx, sealed);
    } catch {
      return null;
    }
  };

  /**
   * PN (D17): health / sync of a managed number — key, number on the key, our webhook
   * (re-set once when the partner lost it), details, status. Key problems end in
   * `needs_reconnect` (a superadmin replaces the key).
   */
  const syncManaged = async (
    loaded: WhatsAppChannelDoc,
    actor: WaActor,
  ): Promise<WhatsAppChannelDoc> => {
    const pin = pinnacleOf();
    // callers may have read the row without the sealed fields: read them here
    const channel =
      loaded.tokenSealed === undefined || loaded.pinnacle?.webhookSecretSealed === undefined
        ? ((await WhatsAppChannelModel.findById(loaded._id)
            .select(SECRET_FIELDS)
            .lean<WhatsAppChannelDoc>()) ?? loaded)
        : loaded;
    const key = tokenOf(channel);
    if (!key) return markNeedsReconnect(ctx, channel, PROVIDER_KEY_INVALID, actor);
    const now = nowOf(ctx);
    const phoneNumberId = channel.phoneNumberId ?? '';
    try {
      const numbers = await pin.getUserDetails(key);
      if (!numbers.some((n) => n.phoneNumberId === phoneNumberId)) {
        return await markNeedsReconnect(ctx, channel, PROVIDER_NUMBER_MISSING, actor);
      }
      const secret = webhookSecretOf(channel);
      let webhookOk = secret ? await webhookMatches(pin, key, channel, secret) : false;
      let reset = false;
      if (!webhookOk && secret) {
        try {
          await setWebhookChecked(pin, key, channel, secret);
          webhookOk = true;
          reset = true;
        } catch (err) {
          log().warn(
            { channelId: channel._id.toString(), errName: (err as Error).name },
            'whatsapp: partner webhook could not be set again',
          );
        }
      }
      const waba = await pin.getWaba(key, channel.wabaId);
      const phone = await pin.getPhoneNumber(key, phoneNumberId);
      const { status, why } = managedState(channel, phone.status, webhookOk);
      const updated = await transition(ctx, channel, status, why, actor, {
        ...wabaPatch(waba),
        ...phonePatch(phone),
        registration: {
          ...channel.registration,
          status:
            phone.status === 'CONNECTED'
              ? channel.registration.status === 'registered'
                ? 'registered'
                : 'not_needed'
              : 'pending',
          error: phone.status === 'CONNECTED' ? null : (channel.registration.error ?? null),
        },
        tokenCheckedAt: now,
        syncedAt: now,
        restriction:
          status === 'restricted'
            ? (channel.restriction ?? { type: phone.status ?? 'RESTRICTED', until: null })
            : null,
        'pinnacle.keyCheckedAt': now,
        ...(reset
          ? {
              'pinnacle.webhookUrl': pinnacleWebhookUrl(ctx.env, channel._id),
              'pinnacle.webhookSetAt': now,
            }
          : {}),
      });
      if (reset) {
        await auditChannel(updated, 'whatsapp.managed_webhook_reset', actor, { automatic: true });
      }
      await notifyDetailChanges(ctx, channel, updated);
      return updated;
    } catch (err) {
      if (isMetaApiError(err) && err.tokenInvalid) {
        return markNeedsReconnect(ctx, channel, PROVIDER_KEY_INVALID, actor);
      }
      throw partnerError(err);
    }
  };

  /**
   * PN: superadmin adds a number that lives at Pinnacle (D2 / T5): key check, details,
   * channel, our webhook at the partner (read back — otherwise nothing is kept), status.
   */
  const connectManaged = async (input: {
    accountId: Types.ObjectId;
    actor: WaActor;
    label: string;
    wabaId: string;
    phoneNumberId: string;
    apiKey: string;
    creditLine: 'partner_pending' | 'partner_active';
  }) => {
    const pin = pinnacleOf();
    return withLock(input.phoneNumberId, async () => {
      await checkKey(pin, input.apiKey, input.wabaId, input.phoneNumberId);
      if (await activeElsewhere(input.phoneNumberId, null)) {
        throw new AppError('WHATSAPP_NUMBER_IN_USE');
      }
      const count = await WhatsAppChannelModel.countDocuments({
        accountId: input.accountId,
        status: { $in: WA_ACTIVE_STATUSES },
      });
      if (count >= WHATSAPP_LIMITS.maxChannelsPerAccount)
        throw new AppError('WHATSAPP_CHANNEL_LIMIT');
      let waba: MetaWaba;
      let phone: MetaPhone;
      try {
        waba = await pin.getWaba(input.apiKey, input.wabaId);
        phone = await pin.getPhoneNumber(input.apiKey, input.phoneNumberId);
      } catch (err) {
        if (isMetaApiError(err) && err.tokenInvalid) throw new AppError('PINNACLE_KEY_INVALID');
        throw partnerError(err);
      }
      const now = nowOf(ctx);
      const secret = randomBytes(32).toString('base64url');
      let channel: WhatsAppChannelDoc;
      try {
        const created = await WhatsAppChannelModel.create({
          accountId: input.accountId,
          label: input.label.slice(0, WHATSAPP_LIMITS.labelMax),
          provider: 'pinnacle',
          mode: 'cloud_api',
          wabaId: input.wabaId,
          ...wabaPatch(waba),
          phoneNumberId: input.phoneNumberId,
          ...phonePatch(phone),
          phoneE164: toE164(phone.displayPhoneNumber),
          tokenSealed: sealSecret(ctx, input.apiKey),
          tokenType: 'pinnacle_api_key',
          tokenScopes: [],
          tokenExpiresAt: null,
          tokenCheckedAt: now,
          metaUserId: null,
          metaPayer: 'platform',
          creditLine: { status: input.creditLine, allocationConfigId: null, error: null, at: now },
          subscription: { status: 'subscribed', error: null, at: now },
          registration: {
            status: phone.status === 'CONNECTED' ? 'not_needed' : 'pending',
            pinSealed: null,
            error: null,
            at: null,
          },
          pinnacle: {
            webhookSecretSealed: sealSecret(ctx, secret),
            webhookUrl: null,
            webhookSetAt: null,
            keyLast4: input.apiKey.slice(-4),
            keyCheckedAt: now,
            lastBalanceErrorAt: null,
            addedBy: input.actor.id,
          },
          connectedBy: input.actor.id,
          connectedAt: now,
          status: 'connecting',
          history: [{ status: 'connecting', reason: null, at: now, by: input.actor.id }],
        });
        channel = created.toObject({ transform: false });
      } catch (err) {
        if (isDuplicateKeyError(err)) throw new AppError('WHATSAPP_NUMBER_IN_USE');
        throw err;
      }
      try {
        await setWebhookChecked(pin, input.apiKey, channel, secret);
      } catch (err) {
        // nothing is kept when the partner didn't take our webhook
        await WhatsAppChannelModel.deleteOne({ _id: channel._id });
        throw err;
      }
      resetManagedNumbersCache();
      // not registered on the Cloud API yet (Meta shows "Pending"): register it right away
      let phoneStatus = phone.status;
      let registration: Partial<WhatsAppChannelDoc> = {};
      let pinNeeded = false;
      if (phoneStatus !== 'CONNECTED' && !RESTRICTED_PHONE_STATUSES.has(phoneStatus ?? '')) {
        const regPin = registerPinOf();
        try {
          await pin.registerPhone(input.apiKey, input.phoneNumberId, regPin);
          phoneStatus = 'CONNECTED';
          registration = {
            registration: {
              status: 'registered',
              pinSealed: sealSecret(ctx, regPin),
              error: null,
              at: now,
            },
            phoneStatus: 'CONNECTED',
          };
        } catch (err) {
          if (!isMetaApiError(err)) throw err;
          await noteProviderError(ctx, channel._id, err);
          pinNeeded = err.code === META_ERROR_CODES.pinMismatch;
          registration = {
            registration: {
              ...channel.registration,
              status: 'pending',
              error: err.message.slice(0, 300),
            },
          };
          log().warn(
            { channelId: channel._id.toString(), code: err.code },
            'whatsapp: managed number could not be registered on add',
          );
        }
      }
      const state = managedState(channel, phoneStatus, true);
      const { status, why } =
        pinNeeded && state.why?.code === REGISTER_AT_PARTNER.code
          ? { status: state.status, why: PIN_REQUIRED }
          : state;
      const updated = await transition(ctx, channel, status, why, input.actor, {
        ...registration,
        'pinnacle.webhookUrl': pinnacleWebhookUrl(ctx.env, channel._id),
        'pinnacle.webhookSetAt': now,
        syncedAt: now,
        ...(status === 'restricted'
          ? { restriction: { type: phone.status ?? 'RESTRICTED', until: null } }
          : {}),
      });
      await auditChannel(updated, 'whatsapp.managed_number_added', input.actor, {
        byAdmin: true,
        keyLast4: input.apiKey.slice(-4),
        creditLine: input.creditLine,
      });
      await connected(updated);
      return { channel: channelListItem(updated), outcome: outcomeOf(updated) };
    });
  };

  /** PN: a new partner API key for a managed number (checked, webhook set with it). */
  const replaceManagedKey = async (channelId: string, apiKey: string, actor: WaActor) => {
    const pin = pinnacleOf();
    const channel = await loadManaged(channelId);
    return withLock(channel.phoneNumberId ?? `waba-${channel.wabaId}`, async () => {
      await checkKey(pin, apiKey, channel.wabaId, channel.phoneNumberId ?? '');
      const secret = webhookSecretOf(channel) ?? randomBytes(32).toString('base64url');
      await setWebhookChecked(pin, apiKey, channel, secret);
      const now = nowOf(ctx);
      const before = channel.pinnacle?.keyLast4 ?? null;
      const saved = await persist(channel, {
        tokenSealed: sealSecret(ctx, apiKey),
        tokenCheckedAt: now,
        ...({
          'pinnacle.webhookSecretSealed': sealSecret(ctx, secret),
          'pinnacle.keyLast4': apiKey.slice(-4),
          'pinnacle.keyCheckedAt': now,
          'pinnacle.webhookUrl': pinnacleWebhookUrl(ctx.env, channel._id),
          'pinnacle.webhookSetAt': now,
        } as Partial<WhatsAppChannelDoc>),
      });
      const full = await WhatsAppChannelModel.findById(saved._id)
        .select(SECRET_FIELDS)
        .lean<WhatsAppChannelDoc>();
      const synced = await syncManaged(full ?? saved, actor);
      await auditChannel(synced, 'whatsapp.managed_key_replaced', actor, {
        byAdmin: true,
        fromLast4: before,
        toLast4: apiKey.slice(-4),
      });
      await connected(synced);
      return channelListItem(synced);
    });
  };

  /** PN: a fresh webhook secret, set at the partner and read back. */
  const resetManagedWebhook = async (channelId: string, actor: WaActor) => {
    const pin = pinnacleOf();
    const channel = await loadManaged(channelId);
    const key = tokenOf(channel);
    if (!key) throw new AppError('PINNACLE_KEY_INVALID');
    return withLock(channel.phoneNumberId ?? `waba-${channel.wabaId}`, async () => {
      const secret = randomBytes(32).toString('base64url');
      await setWebhookChecked(pin, key, channel, secret);
      const now = nowOf(ctx);
      const saved = await persist(channel, {
        'pinnacle.webhookSecretSealed': sealSecret(ctx, secret),
        'pinnacle.webhookUrl': pinnacleWebhookUrl(ctx.env, channel._id),
        'pinnacle.webhookSetAt': now,
      } as Partial<WhatsAppChannelDoc>);
      const full = await WhatsAppChannelModel.findById(saved._id)
        .select(SECRET_FIELDS)
        .lean<WhatsAppChannelDoc>();
      const synced = await syncManaged(full ?? saved, actor);
      await auditChannel(synced, 'whatsapp.managed_webhook_reset', actor, { byAdmin: true });
      await connected(synced);
      return channelListItem(synced);
    });
  };

  /** PN (D10 / D12): the partner credit line state as the superadmin sees it in the panel. */
  const setManagedCreditLine = async (
    channelId: string,
    status: 'partner_pending' | 'partner_active',
    actor: WaActor,
  ) => {
    const channel = await loadManaged(channelId);
    const from = channel.creditLine.status;
    const saved = await persist(channel, {
      creditLine: { ...channel.creditLine, status, at: nowOf(ctx), error: null },
    });
    const full = await WhatsAppChannelModel.findById(saved._id)
      .select(SECRET_FIELDS)
      .lean<WhatsAppChannelDoc>();
    const synced = await syncManaged(full ?? saved, actor);
    await auditChannel(synced, 'whatsapp.credit_line_updated', actor, {
      byAdmin: true,
      from,
      to: status,
    });
    await connected(synced);
    return channelListItem(synced);
  };

  // ── views / internal ──────────────────────────────────────────────────────
  const listChannels = async (accountId: Types.ObjectId, status?: WhatsAppChannelDoc['status']) => {
    const channels = await WhatsAppChannelModel.find({ accountId, ...(status ? { status } : {}) })
      .sort({ createdAt: -1 })
      .lean<WhatsAppChannelDoc[]>();
    const counts: Record<string, number> = {};
    for (const c of channels) counts[c.status] = (counts[c.status] ?? 0) + 1;
    return {
      items: channels.map(channelListItem),
      counts,
      limit: WHATSAPP_LIMITS.maxChannelsPerAccount,
    };
  };

  const events24h = async (channelId: Types.ObjectId): Promise<ChannelEvents24h> => {
    const since = new Date(nowOf(ctx).getTime() - 24 * 60 * 60 * 1000);
    const rows = await MetaWebhookEventModel.aggregate<{ _id: string; n: number }>([
      { $match: { channelId, receivedAt: { $gte: since } } },
      { $group: { _id: '$field', n: { $sum: 1 } } },
    ]);
    const byField = Object.fromEntries(rows.map((r) => [r._id, r.n]));
    return { total: rows.reduce((sum, r) => sum + r.n, 0), byField };
  };

  const getChannel = async (accountId: Types.ObjectId, id: string) => {
    const channel = await load(accountId, id);
    return channelDetail(channel, await events24h(channel._id));
  };

  /** Server-side only (Phases 10–12): the opened business token of a usable channel. */
  const getChannelToken = async (channelId: Types.ObjectId | string) => {
    const channel = await WhatsAppChannelModel.findById(channelId)
      .select(SECRET_FIELDS)
      .lean<WhatsAppChannelDoc>();
    if (!channel) throw new NotFoundError('WhatsApp number not found');
    if (channel.status !== 'connected' && channel.status !== 'action_needed') throw notReady();
    const token = tokenOf(channel);
    if (!token) throw notReady();
    return { channel, token };
  };

  return {
    connect,
    retrySetup,
    submitPin,
    sync,
    syncChannel,
    retryCoexistenceSync,
    rename,
    disconnect,
    listChannels,
    getChannel,
    getChannelToken,
    // PN: managed numbers (superadmin)
    connectManaged,
    replaceManagedKey,
    resetManagedWebhook,
    setManagedCreditLine,
    /** For tests / audits: the last 4 digits helper. */
    phoneLast4,
  };
};

export type WhatsAppService = ReturnType<typeof createWhatsAppService>;
