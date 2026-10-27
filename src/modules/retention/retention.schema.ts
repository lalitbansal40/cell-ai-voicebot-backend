import { RETENTION_LIMITS } from '../../config/limits';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

const days = z.number().int().min(1).max(RETENTION_LIMITS.maxDays).nullable();

/** `PUT /account/retention` — days per kind; `null` = the platform default. */
export const RetentionBody = z
  .strictObject({
    recordingsDays: days.optional(),
    callsDays: days.optional(),
    inboxDays: days.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

/** `PUT /admin/accounts/:id/retention-cap` — `null` = no cap (the platform default). */
export const RetentionCapBody = z.strictObject({ callsDays: days, inboxDays: days });

const triple = <T extends z.ZodType>(t: T) =>
  z.object({ recordingsDays: t, callsDays: t, inboxDays: t });

export const RetentionSchema = registry.register(
  'Retention',
  z.object({
    settings: triple(z.number().int().nullable()),
    effective: z.object({
      recordingsDays: z.number().int(),
      callsDays: z.number().int(),
      inboxDays: z.number().int().nullable(),
    }),
    platform: z.object({ callsDays: z.number().int(), inboxDays: z.number().int().nullable() }),
    cap: z.object({
      callsDays: z.number().int().nullable(),
      inboxDays: z.number().int().nullable(),
    }),
    bounds: triple(z.object({ min: z.number().int(), max: z.number().int() })),
  }),
);

const tags = ['Account'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/account/retention',
  tags,
  summary: 'How long recordings, call records and WhatsApp chats are kept (account.read)',
  security: bearer,
  responses: { 200: ok(RetentionSchema), 401: errors[401], 403: errors[403] },
});
registry.registerPath({
  method: 'put',
  path: '/api/v1/account/retention',
  tags,
  summary: `Change how long data is kept (account.update; calls ≥ ${String(RETENTION_LIMITS.callsMinDays)}, chats ≥ ${String(RETENTION_LIMITS.inboxMinDays)}, recordings ≥ ${String(RETENTION_LIMITS.recordingsMinDays)} and ≤ calls, ≤ the platform maximum; 422 RETENTION_OUT_OF_BOUNDS)`,
  security: bearer,
  request: json(RetentionBody),
  responses: { 200: ok(RetentionSchema), 401: errors[401], 403: errors[403], 422: errors[422] },
});
