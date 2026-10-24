import { WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { CALL_AVAILABILITY } from '../../db/models/user.model';
import {
  CALL_ICON_VISIBILITY,
  HHMM_PATTERN,
  INBOUND_ROUTES,
  ISO2_PATTERN,
  ISO_DATE_PATTERN,
  WEEK_DAYS,
} from '../../db/models/whatsapp-channel.model';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

/** A known IANA time zone (`Asia/Kolkata`); Meta refuses others. */
export const isTimeZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz);
  } catch {
    return false;
  }
};

const hhmm = z.string().regex(HHMM_PATTERN, 'Use HHMM (24 h), e.g. 0930');

export const CallHoursBody = z.object({
  enabled: z.boolean(),
  timezone: z.string().max(64).refine(isTimeZone, 'Not a known time zone'),
  weekly: z
    .array(z.object({ day: z.enum(WEEK_DAYS), open: hhmm, close: hhmm }))
    .max(WEEK_DAYS.length * WHATSAPP_CALL_LIMITS.callHoursEntriesPerDayMax),
  holidays: z
    .array(
      z.object({
        date: z.string().regex(ISO_DATE_PATTERN, 'Use YYYY-MM-DD'),
        start: hhmm,
        end: hhmm,
      }),
    )
    .max(WHATSAPP_CALL_LIMITS.holidaysMax),
});

export const ProgramBody = z.object({ kind: z.enum(['flow', 'agent']), id: ObjectIdSchema });

/** `PATCH /whatsapp/channels/:id/calling` — every field optional, at least one. */
export const CallingSettingsPatch = z
  .object({
    status: z.enum(['enabled', 'disabled']).optional(),
    callIconVisibility: z.enum(CALL_ICON_VISIBILITY).optional(),
    iconCountries: z
      .array(z.string().trim().toUpperCase().regex(ISO2_PATTERN, 'Use 2-letter country codes'))
      .max(250)
      .optional(),
    callHours: CallHoursBody.optional(),
    callbackPermission: z.boolean().optional(),
    inbound: z
      .object({
        route: z.enum(INBOUND_ROUTES).optional(),
        aiProgram: ProgramBody.nullable().optional(),
        ringTimeoutSec: z
          .number()
          .int()
          .min(10)
          .max(WHATSAPP_CALL_LIMITS.uicRingTimeoutSec)
          .optional(),
        ringUserIds: z
          .array(ObjectIdSchema)
          .max(WHATSAPP_CALL_LIMITS.ringTargetsMax)
          .nullable()
          .optional(),
      })
      .optional(),
    permissionRequestBody: z
      .string()
      .trim()
      .min(1)
      .max(WHATSAPP_CALL_LIMITS.requestBodyMax)
      .optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change')
  .openapi('WhatsAppCallingSettingsPatch');
export type CallingSettingsPatchInput = z.infer<typeof CallingSettingsPatch>;

export const CallAvailabilityBody = z
  .object({ status: z.enum(CALL_AVAILABILITY) })
  .openapi('CallAvailability');
