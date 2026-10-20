import { CALL_CAP_RANGES, CALL_LIMITS } from '../../config/limits';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { TimezoneSchema, PublicAccountSchema } from '../auth/auth.schema';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CallingWindowInput = z
  .strictObject({
    start: z.string().regex(HHMM, 'Must be HH:mm (24 h)'),
    end: z.string().regex(HHMM, 'Must be HH:mm (24 h)'),
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((d) => new Set(d).size === d.length, 'Days must be unique'),
  })
  .refine((w) => w.start < w.end, { message: 'Start must be before end', path: ['end'] })
  .openapi({ example: { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] } });

const cap = (r: { min: number; max: number }) => z.number().int().min(r.min).max(r.max);

/** Per-contact call caps, counted across all campaigns of the account (Phase 8). */
export const CallCapsInput = z
  .strictObject({
    perDay: cap(CALL_CAP_RANGES.perDay),
    perWeek: cap(CALL_CAP_RANGES.perWeek),
    minGapMinutes: cap(CALL_CAP_RANGES.minGapMinutes),
  })
  .refine((c) => c.perWeek >= c.perDay, {
    message: 'Calls per week must be at least the calls per day',
    path: ['perWeek'],
  })
  .openapi({ example: { perDay: 3, perWeek: 10, minGapMinutes: 30 } });

export const CALLING_WINDOW_WARNINGS = ['outside_trai', 'outside_rbi_recovery'] as const;

/** The account plus a warning when its calling window leaves the regulatory hours. */
export const AccountWithWarningSchema = registry.register(
  'AccountWithWarning',
  PublicAccountSchema.extend({
    callingWindowWarning: z.enum(CALLING_WINDOW_WARNINGS).nullable().openapi({
      description:
        'outside_trai: starts before 09:00 or ends after 21:00 (live calls are held to it); outside_rbi_recovery: outside 08:00–19:00 (live recovery calls)',
    }),
  }),
);

export const UpdateAccountBody = z
  .strictObject({
    name: z.string().trim().min(2).max(80).optional(),
    timezone: TimezoneSchema.optional(),
    country: z
      .string()
      .regex(/^[A-Z]{2}$/, 'Must be an ISO-3166 alpha-2 code like IN')
      .optional(),
    defaultLanguage: z.enum(['hi', 'en', 'hinglish']).optional(),
    settings: z
      .strictObject({
        callingWindow: CallingWindowInput.optional(),
        callCaps: CallCapsInput.optional().openapi({ description: 'Owner / admin only' }),
        recordingEnabled: z.boolean().optional(),
        recordingNotice: z
          .string()
          .trim()
          .min(1)
          .max(CALL_LIMITS.recordingNoticeMaxChars)
          .optional(),
        aiDisclosureEnabled: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Send at least one field');

registry.registerPath({
  method: 'get',
  path: '/api/v1/account',
  tags: ['Account'],
  summary: 'Your account and its settings (account.read)',
  security: bearer,
  responses: { 200: ok(AccountWithWarningSchema), 401: errors[401], 403: errors[403] },
});

registry.registerPath({
  method: 'patch',
  path: '/api/v1/account',
  tags: ['Account'],
  summary: 'Update account settings (account.update) — nested settings are merged',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: UpdateAccountBody } } } },
  responses: {
    200: ok(AccountWithWarningSchema),
    401: errors[401],
    403: errors[403],
    422: errors[422],
  },
});
