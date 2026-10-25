import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

import { WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { FakeWaUser } from '../telephony/whatsapp/fake-user';

import {
  callActionSchema,
  callAnalyticsSchema,
  toCallAnalyticsPoints,
  callingBlockSchema,
  callingSettingsBody,
  callPermissionsSchema,
  startCallSchema,
  toCallingSettings,
  toCallPermission,
} from './call-schemas';
import type {
  MetaApiError,
  MetaCallingSettingsUpdate,
  MetaClient,
  MetaMessagePayload,
} from './types';

/**
 * DEV / TEST ONLY — WhatsApp calling in the fake Meta (PHASE_12_PROMPT §1). Call
 * state and permissions live in Redis; the customer's WebRTC side (`FakeWaUser`,
 * 127.0.0.1 only) lives in this process. Every Meta event goes out as a signed
 * webhook through the real receiver (the fake's emitter). Timers are `unref()`'d
 * and cleared by `stopCalls()`.
 */

/** Customer number ending → calling behaviour (tests / E2E). */
export const FAKE_CALL_KNOBS = {
  /** Answers after 2 s. */
  answersAfter2s: '00020',
  /** Rejects the call. */
  rejects: '00021',
  /** Rings until we hang up (unanswered). */
  neverAnswers: '00022',
  /** Accepts a permission request (temporary, 7 days). */
  permissionTemporary: '00023',
  /** Accepts a permission request permanently. */
  permissionPermanent: '00024',
  /** Declines a permission request. */
  permissionDeclines: '00025',
  /** Old WhatsApp: permission requests / call buttons fail 131026. */
  oldClient: '00026',
  /** Answers, then hangs up 5 s later. */
  hangsUpAfter5s: '00027',
  /** Answers and presses `1` 3 s after media starts. */
  pressesOne: '00028',
  /** Connect fails with 138004. */
  connectFails: '00029',
  /** Meta says there is no permission (138006), whatever our row says. */
  noPermission: '00030',
} as const;

export interface FakePhoneRef {
  phoneNumberId: string;
  wabaId: string;
  displayPhone: string;
  onBizApp: boolean;
}

export interface FakeCallingDeps {
  redis: Redis;
  key: (name: string) => string;
  track: (op: keyof MetaClient, target: string | null) => void;
  /** Phone of a token (throws Graph 190 / not found like the other fake calls). */
  phoneOf: (token: string, phoneNumberId: string) => Promise<FakePhoneRef>;
  /** Phone without a token (simulator), null when unknown. */
  phoneById: (phoneNumberId: string) => Promise<FakePhoneRef | null>;
  /** Hands a webhook body to the real receiver (no-op without an emitter). */
  emit: (body: Record<string, unknown>) => Promise<void>;
  fail: (status: number, code: number, message: string) => MetaApiError;
  /** The number of a WABA the token owns (analytics). */
  phoneOfWaba: (token: string, wabaId: string) => Promise<FakePhoneRef>;
  /** `[connect, ringing, accepted]` ms; null = immediately one after another. */
  delaysMs: readonly [number, number, number] | null;
}

type Direction = 'BUSINESS_INITIATED' | 'USER_INITIATED';
type CallState = 'ringing' | 'accepted' | 'ended';

interface StoredCall {
  waCallId: string;
  phoneNumberId: string;
  waId: string;
  direction: Direction;
  state: CallState;
  bizOpaque: string | null;
  /** UIC: the answer we pre-accepted with (accept must send the same one). */
  preAcceptSdpHash: string | null;
  createdAt: number;
  acceptedAt: number | null;
  endedAt: number | null;
  endStatus: 'COMPLETED' | 'FAILED' | null;
  durationSec: number | null;
}

interface StoredPermission {
  status: 'no_permission' | 'temporary' | 'permanent';
  expiresAt: number | null;
  /** Request send times (ms) — 1 / 24 h, 2 / 7 days. */
  requests: number[];
  /** Connected call times (ms) — 100 / 24 h. */
  connected: number[];
  unanswered: number;
}

/** Dev view of one fake call (`GET /dev/meta/calls`). No SDP, no full phone number. */
export interface FakeCallView {
  waCallId: string;
  phoneNumberId: string;
  toLast4: string;
  direction: Direction;
  state: CallState;
  endStatus: 'COMPLETED' | 'FAILED' | null;
  durationSec: number | null;
  heardTone: boolean;
  heardLevel: number | null;
  dtmfSent: string;
  connected: boolean;
}

export interface FakeCalling {
  methods: Pick<
    MetaClient,
    | 'startCall'
    | 'preAcceptCall'
    | 'acceptCall'
    | 'rejectCall'
    | 'terminateCall'
    | 'getPhoneSettings'
    | 'updateCallingSettings'
    | 'getCallPermissions'
    | 'getCallAnalytics'
  >;
  /** Called by `sendMessage` before a send: permission requests / call buttons. */
  beforeSend(phone: FakePhoneRef, payload: MetaMessagePayload): Promise<'old_client' | null>;
  /** Called by `sendMessage` after a send got its wamid (permission reply knobs). */
  afterSend(phone: FakePhoneRef, payload: MetaMessagePayload, waMessageId: string): void;
  /** Simulator `user_call`: the customer calls the number → `connect` webhook. */
  userCall(
    phoneNumberId: string,
    waId: string,
    options?: {
      name?: string | null;
      bsuid?: string | null;
      ctaPayload?: string | null;
      deeplinkPayload?: string | null;
      /** A caller Meta knows by BSUID only (no phone number in the webhook). */
      withoutPhone?: boolean;
    },
  ): Promise<{ waCallId: string }>;
  userHangup(waCallId: string): Promise<boolean>;
  userDtmf(waCallId: string, digits: string): Promise<boolean>;
  /** Simulator: the customer answers the last permission request (reply webhook). */
  userPermissionReply(
    phoneNumberId: string,
    waId: string,
    response: 'accept' | 'permanent' | 'reject',
  ): Promise<void>;
  /** Simulator: sets the customer's permission at Meta (`permission_*` kinds). */
  setPermission(
    phoneNumberId: string,
    waId: string,
    status: StoredPermission['status'],
    expiresAt?: Date | null,
  ): Promise<void>;
  /** Simulator: adds / clears a calling restriction on the number. */
  setRestriction(
    phoneNumberId: string,
    restriction: { type: string; reason?: string | null; expiresAt?: Date | null } | null,
  ): Promise<void>;
  calls(phoneNumberId: string): Promise<FakeCallView[]>;
  /** Hangs up every fake customer and cancels pending events (shutdown / tests). */
  stopCalls(): Promise<void>;
}

const DAY_MS = 86_400_000;
const STATE_TTL_SEC = 7 * 24 * 3600;
const LOG_MAX = 200;
const digits = (v: string) => v.replace(/\D/g, '');
const unix = (ms: number) => String(Math.floor(ms / 1000));

const hash = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(16);
};

/** Meta's interactive / template calling message kinds in a send payload. */
const callKindOf = (payload: MetaMessagePayload): 'permission_request' | 'voice_call' | null => {
  if (payload.type === 'interactive') {
    const t = (payload.interactive as { type?: unknown } | undefined)?.type;
    if (t === 'call_permission_request') return 'permission_request';
    if (t === 'voice_call') return 'voice_call';
  }
  return null;
};

export const createFakeCalling = (deps: FakeCallingDeps): FakeCalling => {
  const { redis, key, track, fail } = deps;
  const users = new Map<string, FakeWaUser>();
  /** Last permission request per number × customer (the reply's `context.id`). */
  const lastRequests = new Map<string, string>();
  const timers = new Set<NodeJS.Timeout>();
  let stopped = false;

  const later = (ms: number, fn: () => Promise<void>) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void fn().catch(() => undefined);
    }, ms);
    timer.unref();
    timers.add(timer);
  };

  const delay = (i: 0 | 1 | 2) => deps.delaysMs?.[i] ?? 0;

  /* ── state ── */

  const callKey = (id: string) => key(`call-${id}`);
  const loadCall = async (id: string): Promise<StoredCall | null> => {
    const raw = await redis.get(callKey(id));
    return raw ? (JSON.parse(raw) as StoredCall) : null;
  };
  const saveCall = async (c: StoredCall) => {
    await redis.set(callKey(c.waCallId), JSON.stringify(c), 'EX', STATE_TTL_SEC);
    await redis.lrem(key(`calls-${c.phoneNumberId}`), 0, c.waCallId);
    await redis.lpush(key(`calls-${c.phoneNumberId}`), c.waCallId);
    await redis.ltrim(key(`calls-${c.phoneNumberId}`), 0, LOG_MAX - 1);
    await redis.expire(key(`calls-${c.phoneNumberId}`), STATE_TTL_SEC);
  };

  const permKey = (phoneNumberId: string, waId: string) =>
    key(`call-perm-${phoneNumberId}-${waId}`);
  const loadPermission = async (phoneNumberId: string, waId: string): Promise<StoredPermission> => {
    const raw = await redis.get(permKey(phoneNumberId, waId));
    const p: StoredPermission = raw
      ? (JSON.parse(raw) as StoredPermission)
      : { status: 'no_permission', expiresAt: null, requests: [], connected: [], unanswered: 0 };
    const now = Date.now();
    if (p.status === 'temporary' && p.expiresAt !== null && p.expiresAt <= now) {
      p.status = 'no_permission';
      p.expiresAt = null;
    }
    p.requests = p.requests.filter((t) => t > now - 7 * DAY_MS);
    p.connected = p.connected.filter((t) => t > now - DAY_MS);
    return p;
  };
  const savePermission = (phoneNumberId: string, waId: string, p: StoredPermission) =>
    redis.set(permKey(phoneNumberId, waId), JSON.stringify(p), 'EX', 30 * 24 * 3600);

  const permitted = (p: StoredPermission) => p.status === 'temporary' || p.status === 'permanent';
  const requestsIn = (p: StoredPermission, ms: number) =>
    p.requests.filter((t) => t > Date.now() - ms);

  /* ── webhooks ── */

  const envelope = (phone: FakePhoneRef, field: string, value: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: phone.wabaId,
        time: Math.floor(Date.now() / 1000),
        changes: [{ field, value }],
      },
    ],
  });

  const metadata = (phone: FakePhoneRef) => ({
    display_phone_number: digits(phone.displayPhone),
    phone_number_id: phone.phoneNumberId,
  });

  const emitCall = (phone: FakePhoneRef, event: Record<string, unknown>, extra = {}) =>
    deps.emit(
      envelope(phone, 'calls', {
        messaging_product: 'whatsapp',
        metadata: metadata(phone),
        calls: [event],
        ...extra,
      }),
    );

  const emitStatus = (phone: FakePhoneRef, c: StoredCall, status: string) =>
    deps.emit(
      envelope(phone, 'calls', {
        messaging_product: 'whatsapp',
        metadata: metadata(phone),
        statuses: [
          {
            id: c.waCallId,
            timestamp: unix(Date.now()),
            type: 'call',
            status,
            recipient_id: c.waId,
            ...(c.bizOpaque ? { biz_opaque_callback_data: c.bizOpaque } : {}),
          },
        ],
      }),
    );

  const fakeBsuid = (waId: string) => `IN.${hash(`bsuid-${waId}`)}`;

  const callParties = (phone: FakePhoneRef, c: StoredCall) =>
    c.direction === 'USER_INITIATED'
      ? { from: c.waId, from_user_id: fakeBsuid(c.waId), to: digits(phone.displayPhone) }
      : { from: digits(phone.displayPhone), to: c.waId, to_user_id: fakeBsuid(c.waId) };

  /** Ends a call (any side) and sends Meta's terminate webhook once. */
  /** Not picked up (rejected or rang out): Meta counts it — 2 → reminder, 4 → revoked. */
  const notPickedUp = async (phoneNumberId: string, waId: string) => {
    const p = await loadPermission(phoneNumberId, waId);
    p.unanswered += 1;
    if (p.unanswered >= WHATSAPP_CALL_LIMITS.unansweredRevoke) {
      p.status = 'no_permission';
      p.expiresAt = null;
    }
    await savePermission(phoneNumberId, waId, p);
  };

  const end = async (
    c: StoredCall,
    status: 'COMPLETED' | 'FAILED',
    errors?: { code: number; message: string }[],
  ) => {
    const current = await loadCall(c.waCallId);
    if (!current || current.state === 'ended') return;
    const now = Date.now();
    current.state = 'ended';
    current.endedAt = now;
    current.endStatus = status;
    current.durationSec = current.acceptedAt ? Math.round((now - current.acceptedAt) / 1000) : null;
    await saveCall(current);
    const user = users.get(c.waCallId);
    users.delete(c.waCallId);
    if (user) await user.hangup();
    const phone = await deps.phoneById(current.phoneNumberId);
    if (!phone) return;
    await emitCall(
      phone,
      {
        id: current.waCallId,
        ...callParties(phone, current),
        event: 'terminate',
        direction: current.direction,
        timestamp: unix(now),
        status: current.endStatus,
        ...(current.bizOpaque ? { biz_opaque_callback_data: current.bizOpaque } : {}),
        ...(current.acceptedAt
          ? {
              start_time: unix(current.acceptedAt),
              end_time: unix(now),
              duration: current.durationSec,
            }
          : {}),
      },
      errors?.length ? { errors } : {},
    );
  };

  /** The customer picked up: media starts, counters per Meta's rules. */
  const accepted = async (phone: FakePhoneRef, c: StoredCall) => {
    const current = await loadCall(c.waCallId);
    if (!current || current.state !== 'ringing') return;
    current.state = 'accepted';
    current.acceptedAt = Date.now();
    await saveCall(current);
    const p = await loadPermission(current.phoneNumberId, current.waId);
    p.connected.push(Date.now());
    p.unanswered = 0;
    // Meta: request counters reset when a call connects
    p.requests = [];
    await savePermission(current.phoneNumberId, current.waId, p);
    users.get(current.waCallId)?.startTalking();
    if (current.direction === 'BUSINESS_INITIATED') await emitStatus(phone, current, 'ACCEPTED');
    const waId = current.waId;
    if (waId.endsWith(FAKE_CALL_KNOBS.hangsUpAfter5s)) {
      later(5_000, () => end(current, 'COMPLETED'));
    }
    if (waId.endsWith(FAKE_CALL_KNOBS.pressesOne)) {
      later(3_000, async () => {
        await users.get(current.waCallId)?.pressDigits('1');
      });
    }
  };

  const newCallId = () => `wacid.FAKE${randomBytes(12).toString('hex').toUpperCase()}`;

  /* ── settings ── */

  const settingsKey = (phoneNumberId: string) => key(`call-settings-${phoneNumberId}`);
  const loadSettings = async (phoneNumberId: string): Promise<Record<string, unknown>> => {
    const raw = await redis.get(settingsKey(phoneNumberId));
    return raw
      ? (JSON.parse(raw) as Record<string, unknown>)
      : {
          status: 'DISABLED',
          call_icon_visibility: 'DEFAULT',
          callback_permission_status: 'DISABLED',
          sip: { status: 'DISABLED' },
        };
  };

  /* ── permission request replies ── */

  const replyWebhook = (
    phone: FakePhoneRef,
    waId: string,
    contextId: string,
    reply: Record<string, unknown>,
  ) =>
    deps.emit(
      envelope(phone, 'messages', {
        messaging_product: 'whatsapp',
        metadata: metadata(phone),
        contacts: [{ profile: { name: 'Test Customer' }, wa_id: waId, user_id: fakeBsuid(waId) }],
        messages: [
          {
            from: waId,
            from_user_id: fakeBsuid(waId),
            id: `wamid.FAKE${randomBytes(12).toString('hex').toUpperCase()}`,
            timestamp: unix(Date.now()),
            type: 'interactive',
            context: { from: digits(phone.displayPhone), id: contextId },
            interactive: { type: 'call_permission_reply', call_permission_reply: reply },
          },
        ],
      }),
    );

  const grant = async (
    phone: FakePhoneRef,
    waId: string,
    permanent: boolean,
    source: 'user_action' | 'automatic',
    contextId: string,
  ) => {
    const p = await loadPermission(phone.phoneNumberId, waId);
    const expiresAt = permanent
      ? null
      : Date.now() + WHATSAPP_CALL_LIMITS.temporaryPermissionDays * DAY_MS;
    p.status = permanent ? 'permanent' : 'temporary';
    p.expiresAt = expiresAt;
    await savePermission(phone.phoneNumberId, waId, p);
    await replyWebhook(phone, waId, contextId, {
      response: 'accept',
      is_permanent: permanent,
      ...(expiresAt ? { expiration_timestamp: unix(expiresAt) } : {}),
      response_source: source,
    });
  };

  const views = async (phoneNumberId: string): Promise<FakeCallView[]> => {
    const ids = await redis.lrange(key(`calls-${phoneNumberId}`), 0, LOG_MAX - 1);
    const out: FakeCallView[] = [];
    for (const id of ids) {
      const c = await loadCall(id);
      if (!c) continue;
      const stats = users.get(id)?.stats ?? lastStats.get(id);
      out.push({
        waCallId: c.waCallId,
        phoneNumberId: c.phoneNumberId,
        toLast4: c.waId.slice(-4),
        direction: c.direction,
        state: c.state,
        endStatus: c.endStatus,
        durationSec: c.durationSec,
        heardTone: stats?.heardTone ?? false,
        heardLevel: stats?.heardLevel ?? null,
        dtmfSent: stats?.dtmfSent ?? '',
        connected: stats?.connected ?? false,
      });
    }
    return out;
  };

  /** Stats of ended calls (the user object is gone) — dev view only, bounded. */
  const lastStats = new Map<string, FakeWaUser['stats']>();
  const keepUser = (waCallId: string, user: FakeWaUser) => {
    users.set(waCallId, user);
    user.onEnd(() => {
      lastStats.set(waCallId, { ...user.stats });
      if (lastStats.size > LOG_MAX) {
        const first = lastStats.keys().next().value;
        if (first !== undefined) lastStats.delete(first);
      }
    });
  };

  const methods: FakeCalling['methods'] = {
    async startCall(token, phoneNumberId, call) {
      track('startCall', phoneNumberId);
      const phone = await deps.phoneOf(token, phoneNumberId);
      const waId = digits(call.to ?? '');
      if (!waId) throw fail(400, 100, 'Invalid parameter: to');
      if (phone.onBizApp) throw fail(400, 138013, 'Calling is not available for this number');
      const settings = await loadSettings(phoneNumberId);
      if (settings.status !== 'ENABLED') throw fail(400, 138000, 'Calling is disabled');
      if (waId.endsWith(FAKE_CALL_KNOBS.connectFails)) {
        throw fail(400, 138004, 'Connection error');
      }
      const p = await loadPermission(phoneNumberId, waId);
      if (waId.endsWith(FAKE_CALL_KNOBS.noPermission) || !permitted(p)) {
        throw fail(400, 138006, 'No approved call permission from the recipient');
      }
      if (p.connected.length >= WHATSAPP_CALL_LIMITS.connectedCallsPer24h) {
        throw fail(400, 138012, 'Business initiated calls limit reached');
      }
      const active = (await views(phoneNumberId)).find(
        (v) => v.toLast4 === waId.slice(-4) && v.state !== 'ended',
      );
      if (active) {
        const c = await loadCall(active.waCallId);
        if (c?.waId === waId) throw fail(400, 138003, 'Duplicate call');
      }
      const user = new FakeWaUser();
      let answer: string;
      try {
        answer = await user.answer(call.sdpOffer);
      } catch {
        await user.hangup();
        throw fail(400, 138007, 'Invalid SDP offer');
      }
      const c: StoredCall = {
        waCallId: newCallId(),
        phoneNumberId,
        waId,
        direction: 'BUSINESS_INITIATED',
        state: 'ringing',
        bizOpaque: call.bizOpaque ?? null,
        preAcceptSdpHash: null,
        createdAt: Date.now(),
        acceptedAt: null,
        endedAt: null,
        endStatus: null,
        durationSec: null,
      };
      await saveCall(c);
      keepUser(c.waCallId, user);
      // Meta's relay answers at once, then the phone rings, then the customer picks up
      later(delay(0), async () => {
        await emitCall(phone, {
          id: c.waCallId,
          ...callParties(phone, c),
          event: 'connect',
          direction: c.direction,
          timestamp: unix(Date.now()),
          session: { sdp_type: 'answer', sdp: answer },
          ...(c.bizOpaque ? { biz_opaque_callback_data: c.bizOpaque } : {}),
        });
        later(Math.max(0, delay(1) - delay(0)), async () => {
          const now = await loadCall(c.waCallId);
          if (!now || now.state !== 'ringing') return;
          await emitStatus(phone, c, 'RINGING');
          if (waId.endsWith(FAKE_CALL_KNOBS.neverAnswers)) return;
          const pickUp = waId.endsWith(FAKE_CALL_KNOBS.answersAfter2s)
            ? 2_000
            : Math.max(0, delay(2) - delay(1));
          later(pickUp, async () => {
            const ringing = await loadCall(c.waCallId);
            if (!ringing || ringing.state !== 'ringing') return;
            if (waId.endsWith(FAKE_CALL_KNOBS.rejects)) {
              await emitStatus(phone, c, 'REJECTED');
              await notPickedUp(phoneNumberId, c.waId);
              await end(ringing, 'FAILED');
              return;
            }
            await accepted(phone, ringing);
          });
        });
      });
      return {
        waCallId: startCallSchema.parse({ calls: [{ id: c.waCallId }] }).calls[0]?.id ?? '',
      };
    },

    async preAcceptCall(token, phoneNumberId, waCallId, sdpAnswer) {
      track('preAcceptCall', phoneNumberId);
      await deps.phoneOf(token, phoneNumberId);
      const c = await loadCall(waCallId);
      if (c?.phoneNumberId !== phoneNumberId || c.direction !== 'USER_INITIATED') {
        throw fail(400, 100, 'Invalid call id');
      }
      if (c.state !== 'ringing') throw fail(400, 138021, 'The call is not ringing');
      c.preAcceptSdpHash = hash(sdpAnswer);
      await saveCall(c);
      await users.get(waCallId)?.applyAnswer(sdpAnswer);
      callActionSchema.parse({ success: true });
    },

    async acceptCall(token, phoneNumberId, waCallId, sdpAnswer, bizOpaque) {
      track('acceptCall', phoneNumberId);
      const phone = await deps.phoneOf(token, phoneNumberId);
      const c = await loadCall(waCallId);
      if (c?.phoneNumberId !== phoneNumberId || c.direction !== 'USER_INITIATED') {
        throw fail(400, 100, 'Invalid call id');
      }
      if (c.state !== 'ringing') throw fail(400, 138021, 'The call is not ringing');
      // Meta: accept must carry the SDP of pre_accept (else the call fails)
      if (c.preAcceptSdpHash && c.preAcceptSdpHash !== hash(sdpAnswer)) {
        await end(c, 'FAILED', [{ code: 138007, message: 'SDP mismatch' }]);
        throw fail(400, 138007, 'The answer differs from the pre-accepted one');
      }
      if (!c.preAcceptSdpHash) await users.get(waCallId)?.applyAnswer(sdpAnswer);
      c.bizOpaque = bizOpaque ?? c.bizOpaque;
      await saveCall(c);
      await accepted(phone, c);
    },

    async rejectCall(token, phoneNumberId, waCallId) {
      track('rejectCall', phoneNumberId);
      await deps.phoneOf(token, phoneNumberId);
      const c = await loadCall(waCallId);
      if (c?.phoneNumberId !== phoneNumberId) throw fail(400, 100, 'Invalid call id');
      if (c.state === 'ended') return;
      await end(c, 'FAILED');
    },

    async terminateCall(token, phoneNumberId, waCallId) {
      track('terminateCall', phoneNumberId);
      await deps.phoneOf(token, phoneNumberId);
      const c = await loadCall(waCallId);
      if (c?.phoneNumberId !== phoneNumberId) throw fail(400, 100, 'Invalid call id');
      if (c.state === 'ended') return;
      if (c.direction === 'BUSINESS_INITIATED' && c.state === 'ringing') {
        await notPickedUp(phoneNumberId, c.waId);
      }
      await end(c, 'COMPLETED');
    },

    async getPhoneSettings(token, phoneNumberId) {
      track('getPhoneSettings', phoneNumberId);
      await deps.phoneOf(token, phoneNumberId);
      return toCallingSettings(callingBlockSchema.parse(await loadSettings(phoneNumberId)));
    },

    async updateCallingSettings(token, phoneNumberId, calling: MetaCallingSettingsUpdate) {
      track('updateCallingSettings', phoneNumberId);
      const phone = await deps.phoneOf(token, phoneNumberId);
      if (phone.onBizApp && calling.status === 'ENABLED') {
        throw fail(400, 138013, 'Calling is not available for this number');
      }
      for (const day of calling.callHours?.weekly ?? []) {
        if (day.open >= day.close) throw fail(400, 100, 'open_time must be before close_time');
      }
      const before = await loadSettings(phoneNumberId);
      const body = callingSettingsBody(calling);
      const after = { ...before, ...body };
      await redis.set(settingsKey(phoneNumberId), JSON.stringify(after), 'EX', 90 * 24 * 3600);
      // Meta fires the webhook for status / icon visibility / callback changes only
      const watched = ['status', 'call_icon_visibility', 'callback_permission_status'];
      if (watched.some((f) => JSON.stringify(before[f]) !== JSON.stringify(after[f]))) {
        later(0, () =>
          deps.emit(
            envelope(phone, 'account_settings_update', {
              messaging_product: 'whatsapp',
              timestamp: unix(Date.now()),
              type: 'phone_number_settings',
              phone_number_settings: { phone_number_id: phoneNumberId, calling: after },
            }),
          ),
        );
      }
    },

    async getCallAnalytics(token, wabaId, range) {
      track('getCallAnalytics', wabaId);
      const phone = await deps.phoneOfWaba(token, wabaId);
      // answered business-initiated calls of the range, per UTC day, priced at ₹0.3885 / min
      const days = new Map<number, { count: number; pulses: number; seconds: number }>();
      for (const v of await views(phone.phoneNumberId)) {
        const c = await loadCall(v.waCallId);
        if (
          !c?.acceptedAt ||
          c.direction !== 'BUSINESS_INITIATED' ||
          c.state !== 'ended' ||
          c.acceptedAt < range.start.getTime() ||
          c.acceptedAt >= range.end.getTime()
        )
          continue;
        const day = Math.floor(c.acceptedAt / DAY_MS) * 86_400;
        const d = days.get(day) ?? { count: 0, pulses: 0, seconds: 0 };
        d.count += 1;
        d.seconds += c.durationSec ?? 0;
        d.pulses += Math.ceil((c.durationSec ?? 0) / WHATSAPP_CALL_LIMITS.pulseSec);
        days.set(day, d);
      }
      const points = [...days.entries()].map(([start, d]) => ({
        start,
        end: start + 86_400,
        direction: 'BUSINESS_INITIATED',
        country: 'IN',
        count: d.count,
        cost: Math.round(d.pulses * (0.3885 / 10) * 10_000) / 10_000,
        average_duration: d.count ? Math.round(d.seconds / d.count) : 0,
      }));
      return toCallAnalyticsPoints(
        callAnalyticsSchema.parse({ call_analytics: { data_points: points } }),
      );
    },

    async getCallPermissions(token, phoneNumberId, waIdOrBsuid) {
      track('getCallPermissions', phoneNumberId);
      await deps.phoneOf(token, phoneNumberId);
      const waId = digits(waIdOrBsuid);
      const p = await loadPermission(phoneNumberId, waId);
      const knobNone = waId.endsWith(FAKE_CALL_KNOBS.noPermission);
      const status = knobNone ? 'no_permission' : p.status;
      const day = requestsIn(p, DAY_MS);
      const week = p.requests;
      const limit = (period: string, max: number, used: number[], windowMs: number) => ({
        time_period: period,
        max_allowed: max,
        current_usage: used.length,
        ...(used.length >= max && used[0] !== undefined
          ? { limit_expiration_time: Number(unix(Math.min(...used) + windowMs)) }
          : {}),
      });
      const raw = {
        messaging_product: 'whatsapp',
        permission: {
          status,
          ...(status === 'temporary' && p.expiresAt
            ? { expiration_time: Number(unix(p.expiresAt)) }
            : {}),
        },
        actions: [
          {
            action_name: 'send_call_permission_request',
            can_perform_action:
              status !== 'permanent' &&
              day.length < WHATSAPP_CALL_LIMITS.permissionRequestsPerDay &&
              week.length < WHATSAPP_CALL_LIMITS.permissionRequestsPerWeek,
            limits: [
              limit('PT24H', WHATSAPP_CALL_LIMITS.permissionRequestsPerDay, day, DAY_MS),
              limit('P7D', WHATSAPP_CALL_LIMITS.permissionRequestsPerWeek, week, 7 * DAY_MS),
            ],
          },
          {
            action_name: 'start_call',
            can_perform_action:
              status !== 'no_permission' &&
              p.connected.length < WHATSAPP_CALL_LIMITS.connectedCallsPer24h,
            limits: [
              limit('PT24H', WHATSAPP_CALL_LIMITS.connectedCallsPer24h, p.connected, DAY_MS),
            ],
          },
        ],
      };
      return toCallPermission(callPermissionsSchema.parse(raw));
    },
  };

  return {
    methods,

    async beforeSend(phone, payload) {
      const kind = callKindOf(payload);
      if (!kind) return null;
      const waId = digits(payload.to);
      if (waId.endsWith(FAKE_CALL_KNOBS.oldClient)) return 'old_client';
      if (kind !== 'permission_request') return null;
      const p = await loadPermission(phone.phoneNumberId, waId);
      if (p.status === 'permanent') throw fail(400, 138017, 'Permission already granted');
      if (
        requestsIn(p, DAY_MS).length >= WHATSAPP_CALL_LIMITS.permissionRequestsPerDay ||
        p.requests.length >= WHATSAPP_CALL_LIMITS.permissionRequestsPerWeek
      ) {
        throw fail(400, 138009, 'Call permission request limit reached');
      }
      p.requests.push(Date.now());
      await savePermission(phone.phoneNumberId, waId, p);
      return null;
    },

    afterSend(phone, payload, waMessageId) {
      if (callKindOf(payload) !== 'permission_request') return;
      const waId = digits(payload.to);
      lastRequests.set(`${phone.phoneNumberId}:${waId}`, waMessageId);
      if (lastRequests.size > 1_000) lastRequests.delete(lastRequests.keys().next().value ?? '');
      const k = FAKE_CALL_KNOBS;
      if (waId.endsWith(k.permissionTemporary) || waId.endsWith(k.permissionPermanent)) {
        later(delay(2), () =>
          grant(phone, waId, waId.endsWith(k.permissionPermanent), 'user_action', waMessageId),
        );
      } else if (waId.endsWith(k.permissionDeclines)) {
        later(delay(2), () =>
          replyWebhook(phone, waId, waMessageId, {
            response: 'reject',
            is_permanent: false,
            response_source: 'user_action',
          }),
        );
      }
    },

    async userCall(phoneNumberId, waIdRaw, options = {}) {
      const phone = await deps.phoneById(phoneNumberId);
      if (!phone) throw fail(400, 100, 'Unknown phone number');
      const waId = digits(waIdRaw);
      const user = new FakeWaUser();
      const offer = await user.offer();
      const c: StoredCall = {
        waCallId: newCallId(),
        phoneNumberId,
        waId,
        direction: 'USER_INITIATED',
        state: 'ringing',
        bizOpaque: null,
        preAcceptSdpHash: null,
        createdAt: Date.now(),
        acceptedAt: null,
        endedAt: null,
        endStatus: null,
        durationSec: null,
      };
      await saveCall(c);
      keepUser(c.waCallId, user);
      // Meta gives up on an unanswered user call after the answer deadline
      later(WHATSAPP_CALL_LIMITS.uicAnswerDeadlineSec * 1000 * 2, async () => {
        const now = await loadCall(c.waCallId);
        if (now?.state === 'ringing') await end(now, 'FAILED');
      });
      // a user call grants callback permission when the number has it on (Meta: automatic)
      const settings = await loadSettings(phoneNumberId);
      if (settings.callback_permission_status === 'ENABLED') {
        const p = await loadPermission(phoneNumberId, waId);
        if (!permitted(p)) later(0, () => grant(phone, waId, false, 'automatic', c.waCallId));
      }
      await emitCall(
        phone,
        {
          id: c.waCallId,
          ...callParties(phone, c),
          ...(options.bsuid ? { from_user_id: options.bsuid } : {}),
          ...(options.withoutPhone ? { from: undefined } : {}),
          event: 'connect',
          direction: c.direction,
          timestamp: unix(Date.now()),
          session: { sdp_type: 'offer', sdp: offer },
          ...(options.ctaPayload ? { cta_payload: options.ctaPayload } : {}),
          ...(options.deeplinkPayload ? { deeplink_payload: options.deeplinkPayload } : {}),
        },
        {
          contacts: [
            {
              profile: { name: options.name ?? 'Test Customer' },
              ...(options.withoutPhone ? {} : { wa_id: waId }),
              user_id: options.bsuid ?? fakeBsuid(waId),
            },
          ],
        },
      );
      return { waCallId: c.waCallId };
    },

    async userHangup(waCallId) {
      const c = await loadCall(waCallId);
      if (!c || c.state === 'ended') return false;
      await end(c, 'COMPLETED');
      return true;
    },

    async userPermissionReply(phoneNumberId, waIdRaw, response) {
      const phone = await deps.phoneById(phoneNumberId);
      if (!phone) throw fail(400, 100, 'Unknown phone number');
      const waId = digits(waIdRaw);
      const contextId =
        lastRequests.get(`${phoneNumberId}:${waId}`) ??
        `wamid.FAKE${randomBytes(12).toString('hex').toUpperCase()}`;
      if (response !== 'reject') {
        await grant(phone, waId, response === 'permanent', 'user_action', contextId);
        return;
      }
      await replyWebhook(phone, waId, contextId, {
        response: 'reject',
        is_permanent: false,
        response_source: 'user_action',
      });
    },

    async userDtmf(waCallId, keys) {
      const user = users.get(waCallId);
      const c = await loadCall(waCallId);
      if (!user || c?.state !== 'accepted') return false;
      await user.pressDigits(keys);
      return true;
    },

    async setPermission(phoneNumberId, waIdRaw, status, expiresAt) {
      const waId = digits(waIdRaw);
      const p = await loadPermission(phoneNumberId, waId);
      p.status = status;
      p.expiresAt =
        status === 'temporary'
          ? (expiresAt?.getTime() ??
            Date.now() + WHATSAPP_CALL_LIMITS.temporaryPermissionDays * DAY_MS)
          : null;
      await savePermission(phoneNumberId, waId, p);
    },

    async setRestriction(phoneNumberId, restriction) {
      const settings = await loadSettings(phoneNumberId);
      settings.restrictions = restriction
        ? {
            restrictions_list: [
              {
                type: restriction.type,
                reason: restriction.reason ?? 'Paused after negative feedback',
                ...(restriction.expiresAt
                  ? { expiration: Number(unix(restriction.expiresAt.getTime())) }
                  : {}),
              },
            ],
          }
        : undefined;
      await redis.set(settingsKey(phoneNumberId), JSON.stringify(settings), 'EX', 90 * 24 * 3600);
    },

    calls: views,

    async stopCalls() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      const all = [...users.values()];
      users.clear();
      await Promise.all(all.map((u) => u.hangup()));
      stopped = false;
    },
  };
};
