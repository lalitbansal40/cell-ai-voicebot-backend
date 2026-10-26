import { REPORT_LIMITS } from '../../config/limits';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

export const REPORT_TABS = [
  'overview',
  'calls',
  'whatsapp',
  'templates',
  'campaigns',
  'flows',
  'agents',
  'team',
] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Shared report filters: account-local days, one slice at a time (campaign / flow / agent / user / number). */
export const ReportQuery = z.strictObject({
  from: day
    .optional()
    .openapi({ description: 'First day (account timezone). Default: 6 days ago' }),
  to: day.optional().openapi({ description: 'Last day, inclusive. Default: today' }),
  compare: bool.openapi({ description: 'Also return the previous period of the same length' }),
  channel: z
    .enum(['voice', 'whatsapp'])
    .optional()
    .openapi({ description: 'Calls of one channel' }),
  channelId: ObjectIdSchema.optional().openapi({ description: 'A WhatsApp number' }),
  campaignId: ObjectIdSchema.optional(),
  campaignIds: z
    .string()
    .regex(/^[a-f0-9]{24}(,[a-f0-9]{24}){0,9}$/i)
    .optional()
    .openapi({ description: 'Campaigns tab: up to 10 to compare (comma-separated)' }),
  flowId: ObjectIdSchema.optional(),
  agentId: ObjectIdSchema.optional(),
  userId: ObjectIdSchema.optional(),
  includeTest: bool.openapi({ description: 'Count test calls too' }),
});
export type ReportQueryInput = z.infer<typeof ReportQuery>;

export const ReportParams = z.strictObject({ tab: z.enum(REPORT_TABS) });

const UNITS = ['count', 'percent', 'seconds', 'micros'] as const;

export const ReportResponseSchema = registry.register(
  'Report',
  z.object({
    tab: z.enum(REPORT_TABS),
    range: z.object({ from: z.string(), to: z.string(), timezone: z.string() }),
    compareRange: z.object({ from: z.string(), to: z.string() }).nullable(),
    kpis: z.array(
      z.object({
        key: z.string(),
        value: z.number().nullable(),
        previous: z.number().nullable().optional(),
        unit: z.enum(UNITS),
      }),
    ),
    series: z.array(
      z.object({
        key: z.string(),
        unit: z.enum(UNITS),
        points: z.array(z.object({ day: z.string(), value: z.number().nullable() })),
      }),
    ),
    table: z.object({
      columns: z.array(z.object({ key: z.string(), unit: z.enum(UNITS) })),
      rows: z.array(
        z.object({
          id: z.string().nullable(),
          label: z.string(),
          values: z.record(z.string(), z.number().nullable()),
        }),
      ),
    }),
    updatedAt: z.string(),
  }),
);

for (const tab of REPORT_TABS) {
  registry.registerPath({
    method: 'get',
    path: `/api/v1/reports/${tab}`,
    tags: ['Reports'],
    summary: `Report: ${tab} (reports.read; ≤ ${String(REPORT_LIMITS.maxRangeDays)} days; cached ${String(REPORT_LIMITS.cacheTtlSec)} s; ETag / 304; 422 REPORT_RANGE_INVALID)`,
    security: bearer,
    request: { query: ReportQuery },
    responses: {
      200: ok(ReportResponseSchema),
      304: { description: 'Not modified (If-None-Match)' },
      401: errors[401],
      403: errors[403],
      422: errors[422],
    },
  });
}
