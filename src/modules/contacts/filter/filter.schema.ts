import type { FieldType } from '../../../db/models/custom-field.model';
import { registry } from '../../../shared/openapi/registry';
import { z } from '../../../shared/openapi/zod';
import { ObjectIdSchema } from '../../../shared/validation/schemas';

/** Operators allowed per field type (PHASE_3_PLAN §1d). */
export const OPERATORS_BY_TYPE = {
  text: ['eq', 'neq', 'contains', 'exists', 'not_exists'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'not_exists'],
  currency: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'exists', 'not_exists'],
  date: [
    'on',
    'before',
    'after',
    'between',
    'within_next_days',
    'overdue_by_days',
    'exists',
    'not_exists',
  ],
  phone: ['eq', 'exists', 'not_exists'],
} as const satisfies Record<FieldType, readonly string[]>;

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'on',
  'before',
  'after',
  'within_next_days',
  'overdue_by_days',
  'exists',
  'not_exists',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

const ConditionValue = z.union([z.string().trim().max(200), z.number()]);

export const FilterConditionSchema = registry.register(
  'ContactFilterCondition',
  z.strictObject({
    key: z.string().min(1).max(40).openapi({ example: 'days_past_due' }),
    op: z.enum(FILTER_OPERATORS),
    value: ConditionValue.optional().openapi({
      description:
        'Currency in rupees, dates `YYYY-MM-DD`, day counts for within_next_days / overdue_by_days',
    }),
    value2: ConditionValue.optional().openapi({ description: 'Upper bound for `between`' }),
  }),
);

const DateOrDateTime = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

/** Saved / posted contact filter — compiled server-side only (never raw Mongo). */
export const ContactFilterSchema = registry.register(
  'ContactFilter',
  z.strictObject({
    listIds: z.array(ObjectIdSchema).min(1).max(50).optional(),
    tags: z
      .strictObject({
        mode: z.enum(['any', 'all']).default('any'),
        values: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
      })
      .optional(),
    dnd: z.boolean().optional(),
    optedOut: z.boolean().optional(),
    createdFrom: DateOrDateTime.optional(),
    createdTo: DateOrDateTime.optional().openapi({ description: 'Exclusive' }),
    q: z.string().trim().min(1).max(100).optional().openapi({
      description: 'Name, e-mail, external id or phone (any format)',
    }),
    conditions: z.array(FilterConditionSchema).max(20).optional(),
  }),
);

export type ContactFilter = z.infer<typeof ContactFilterSchema>;
export type FilterCondition = z.infer<typeof FilterConditionSchema>;
