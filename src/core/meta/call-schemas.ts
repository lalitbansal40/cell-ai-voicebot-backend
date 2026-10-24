import { z } from 'zod';

import { WHATSAPP_CALL_LIMITS } from '../../config/limits';

import { metaErrorItemSchema, metaTime } from './message-schemas';
import type {
  MetaCallAnalyticsPoint,
  MetaCallHours,
  MetaCallingSettings,
  MetaCallingSettingsUpdate,
  MetaCallPermission,
  MetaWeekDay,
} from './types';

/**
 * WhatsApp calling (Phase 12): Graph answers, webhook values and mappers shared by
 * the Graph client, the fake and the webhook handlers. Field names re-checked on
 * 24 Oct 2026 (Cloud API Calling reference, call settings, user call permissions).
 * SDP strings pass through these schemas but are never logged.
 */

const optStr = z.string().nullish();
const time = z.union([z.string(), z.number()]).nullish();
/** Meta writes enums in upper case in samples and lower case in some tables. */
const upper = z
  .string()
  .transform((v) => v.toUpperCase())
  .nullish();

// ── Graph answers ───────────────────────────────────────────────────────────

export const startCallSchema = z.looseObject({
  messaging_product: z.literal('whatsapp').nullish(),
  calls: z.array(z.looseObject({ id: z.string().min(1) })).min(1),
});

export const callActionSchema = z.looseObject({ success: z.literal(true) });

const hoursSchema = z.looseObject({
  status: upper,
  timezone_id: optStr,
  weekly_operating_hours: z
    .array(z.looseObject({ day_of_week: upper, open_time: optStr, close_time: optStr }))
    .nullish(),
  holiday_schedule: z
    .array(
      z.looseObject({
        date: optStr,
        // the reference table says open_time / close_time; samples use start_time / end_time
        start_time: optStr,
        end_time: optStr,
        open_time: optStr,
        close_time: optStr,
      }),
    )
    .nullish(),
});

const restrictionItemSchema = z.looseObject({
  type: optStr,
  restriction_type: optStr,
  reason: optStr,
  expiration: time,
});

export const callingBlockSchema = z.looseObject({
  status: upper,
  call_icon_visibility: upper,
  call_icons: z
    .looseObject({ restrict_to_user_countries: z.array(z.string()).nullish() })
    .nullish(),
  call_hours: hoursSchema.nullish(),
  callback_permission_status: upper,
  sip: z.looseObject({ status: upper }).nullish(),
  restrictions: z
    .looseObject({
      // the sample says restrictions_list, the field table restriction_list
      restrictions_list: z.array(restrictionItemSchema).nullish(),
      restriction_list: z.array(restrictionItemSchema).nullish(),
    })
    .nullish(),
});

export const phoneSettingsSchema = z.looseObject({ calling: callingBlockSchema.nullish() });

export const callPermissionsSchema = z.looseObject({
  permission: z.looseObject({
    status: z.enum(['no_permission', 'temporary', 'permanent']),
    expiration_time: time,
    expiration: time,
  }),
  actions: z
    .array(
      z.looseObject({
        action_name: z.string(),
        can_perform_action: z.boolean(),
        limits: z
          .array(
            z.looseObject({
              time_period: z.string(),
              max_allowed: z.number(),
              current_usage: z.number(),
              limit_expiration_time: time,
            }),
          )
          .nullish(),
      }),
    )
    .nullish(),
});

const DAYS: readonly MetaWeekDay[] = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];
const isDay = (v: unknown): v is MetaWeekDay => DAYS.includes(v as MetaWeekDay);

const toHours = (raw: z.infer<typeof hoursSchema> | null | undefined): MetaCallHours | null => {
  if (!raw) return null;
  return {
    status: raw.status === 'ENABLED' ? 'ENABLED' : 'DISABLED',
    timezoneId: raw.timezone_id ?? 'UTC',
    weekly: (raw.weekly_operating_hours ?? []).flatMap((w) =>
      isDay(w.day_of_week) && w.open_time && w.close_time
        ? [{ day: w.day_of_week, open: w.open_time, close: w.close_time }]
        : [],
    ),
    holidays: (raw.holiday_schedule ?? []).flatMap((h) => {
      const start = h.start_time ?? h.open_time;
      const end = h.end_time ?? h.close_time;
      return h.date && start && end ? [{ date: h.date, start, end }] : [];
    }),
  };
};

/** Meta's `calling` block (settings answer or `account_settings_update`) → ours. */
export const toCallingSettings = (
  raw: z.infer<typeof callingBlockSchema> | null | undefined,
): MetaCallingSettings => ({
  status: raw?.status ?? null,
  callIconVisibility: raw?.call_icon_visibility ?? null,
  iconCountries: (raw?.call_icons?.restrict_to_user_countries ?? []).map((c) => c.toUpperCase()),
  callHours: toHours(raw?.call_hours),
  callbackPermissionStatus: raw?.callback_permission_status ?? null,
  sipStatus: raw?.sip?.status ?? null,
  restrictions: [
    ...(raw?.restrictions?.restrictions_list ?? []),
    ...(raw?.restrictions?.restriction_list ?? []),
  ].flatMap((r) => {
    const type = r.type ?? r.restriction_type;
    return type ? [{ type, reason: r.reason ?? null, expiresAt: metaTime(r.expiration) }] : [];
  }),
});

export const toCallPermission = (
  raw: z.infer<typeof callPermissionsSchema>,
): MetaCallPermission => ({
  status: raw.permission.status,
  expiresAt: metaTime(raw.permission.expiration_time ?? raw.permission.expiration),
  actions: (raw.actions ?? []).map((a) => ({
    action: a.action_name,
    canPerform: a.can_perform_action,
    limits: (a.limits ?? []).map((l) => ({
      timePeriod: l.time_period,
      maxAllowed: l.max_allowed,
      currentUsage: l.current_usage,
      limitExpiresAt: metaTime(l.limit_expiration_time),
    })),
  })),
});

/** Our settings update → Meta's `calling` body (only the given fields). */
export const callingSettingsBody = (c: MetaCallingSettingsUpdate): Record<string, unknown> => ({
  ...(c.status ? { status: c.status } : {}),
  ...(c.callIconVisibility ? { call_icon_visibility: c.callIconVisibility } : {}),
  ...(c.iconCountries ? { call_icons: { restrict_to_user_countries: c.iconCountries } } : {}),
  ...(c.callHours
    ? {
        call_hours: {
          status: c.callHours.status,
          timezone_id: c.callHours.timezoneId,
          weekly_operating_hours: c.callHours.weekly.map((w) => ({
            day_of_week: w.day,
            open_time: w.open,
            close_time: w.close,
          })),
          // omitting the list clears Meta's holidays — always send ours
          holiday_schedule: c.callHours.holidays.map((h) => ({
            date: h.date,
            start_time: h.start,
            end_time: h.end,
          })),
        },
      }
    : {}),
  ...(c.callbackPermissionStatus ? { callback_permission_status: c.callbackPermissionStatus } : {}),
});

const callPointSchema = z.looseObject({
  start: z.number(),
  end: z.number(),
  direction: optStr,
  country: optStr,
  count: z.number().nullish(),
  cost: z.number().nullish(),
  average_duration: z.number().nullish(),
});

/** `GET /{waba}?fields=call_analytics…` — points flat or grouped under `data[]`. */
export const callAnalyticsSchema = z.looseObject({
  call_analytics: z
    .looseObject({
      data_points: z.array(callPointSchema).nullish(),
      data: z.array(z.looseObject({ data_points: z.array(callPointSchema).default([]) })).nullish(),
    })
    .nullish(),
});

export const toCallAnalyticsPoints = (
  raw: z.infer<typeof callAnalyticsSchema>,
): MetaCallAnalyticsPoint[] =>
  [
    ...(raw.call_analytics?.data_points ?? []),
    ...(raw.call_analytics?.data ?? []).flatMap((d) => d.data_points),
  ].map((p) => ({
    start: new Date(p.start * 1000),
    end: new Date(p.end * 1000),
    direction: p.direction?.toUpperCase() ?? null,
    country: p.country?.toUpperCase() ?? null,
    count: p.count ?? 0,
    cost: p.cost ?? null,
    averageDurationSec: p.average_duration ?? null,
  }));

// ── Webhooks ────────────────────────────────────────────────────────────────

const sessionSchema = z.looseObject({
  sdp_type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(WHATSAPP_CALL_LIMITS.sdpMaxBytes),
});

/** One entry of `value.calls[]` (`connect` / `terminate`). */
export const callEventSchema = z.looseObject({
  id: z.string().min(1),
  event: z.string().min(1),
  from: optStr,
  to: optStr,
  from_user_id: optStr,
  to_user_id: optStr,
  timestamp: time,
  direction: upper,
  session: sessionSchema.nullish(),
  biz_opaque_callback_data: optStr,
  cta_payload: optStr,
  deeplink_payload: optStr,
  // terminate
  status: upper,
  start_time: time,
  end_time: time,
  duration: z.union([z.number(), z.string()]).nullish(),
  errors: z.array(metaErrorItemSchema).nullish(),
});
export type MetaCallEvent = z.infer<typeof callEventSchema>;

/** One entry of `value.statuses[]` with `type: call` (business-initiated calls). */
export const callStatusSchema = z.looseObject({
  id: z.string().min(1),
  type: z.literal('call'),
  status: z
    .string()
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(['RINGING', 'ACCEPTED', 'REJECTED'])),
  timestamp: time,
  recipient_id: optStr,
  recipient_user_id: optStr,
  biz_opaque_callback_data: optStr,
});
export type MetaCallStatus = z.infer<typeof callStatusSchema>;

const contactSchema = z.looseObject({
  wa_id: optStr,
  user_id: optStr,
  profile: z.looseObject({ name: optStr }).nullish(),
});

/** `field: calls` value: connect / terminate events and / or call statuses. */
export const callsValueSchema = z.looseObject({
  messaging_product: z.literal('whatsapp').nullish(),
  metadata: z.looseObject({ display_phone_number: optStr, phone_number_id: z.string().min(1) }),
  contacts: z.array(contactSchema).nullish(),
  calls: z.array(callEventSchema).nullish(),
  statuses: z.array(z.looseObject({ type: optStr })).nullish(),
  /** Terminate errors sit at the value level (Meta's sample). */
  errors: z.array(metaErrorItemSchema).nullish(),
});
export type MetaCallsValue = z.infer<typeof callsValueSchema>;

/** `interactive.call_permission_reply` of an inbound message. */
export const callPermissionReplySchema = z.looseObject({
  response: z.enum(['accept', 'reject']),
  is_permanent: z.boolean().nullish(),
  expiration_timestamp: time,
  response_source: optStr,
});
export type MetaCallPermissionReply = z.infer<typeof callPermissionReplySchema>;

/** `field: account_settings_update` (only calling changes are read). */
export const accountSettingsUpdateValueSchema = z.looseObject({
  timestamp: time,
  type: optStr,
  phone_number_settings: z.looseObject({
    phone_number_id: z.union([z.string().min(1), z.number()]).transform(String),
    calling: callingBlockSchema.nullish(),
  }),
});

/** Calling `account_update` events (Meta: feedback warnings, 7-day pauses, low pickup). */
export const CALLING_RESTRICTION_TYPES = [
  'RESTRICTED_BUSINESS_INITIATED_CALLING',
  'RESTRICTED_USER_INITIATED_CALLING',
  'RESTRICTED_USER_INITIATED_CALLING_CALL_BUTTON_HIDDEN',
] as const;
export const CALLING_VIOLATION_TYPES = [
  'LOW_BUSINESS_INITIATED_CALLING_QUALITY',
  'LOW_USER_INITIATED_CALLING_QUALITY',
  'USER_INITIATED_CALLS_LOW_PICKUP_RATE',
] as const;

export const isCallingRestrictionType = (t: string | null | undefined): boolean =>
  (CALLING_RESTRICTION_TYPES as readonly string[]).includes(t ?? '');
export const isCallingViolationType = (t: string | null | undefined): boolean =>
  (CALLING_VIOLATION_TYPES as readonly string[]).includes(t ?? '');

/** Seconds of a terminate event (`duration`, else end − start), null when not answered. */
export const callDurationSec = (e: MetaCallEvent): number | null => {
  if (e.duration !== null && e.duration !== undefined && e.duration !== '') {
    const n = Number(e.duration);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
  }
  const start = metaTime(e.start_time);
  const end = metaTime(e.end_time);
  return start && end ? Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000)) : null;
};
