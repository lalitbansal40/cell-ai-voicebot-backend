import { POSTCALL_LIMITS } from '../../config/limits';
import { SENTIMENTS } from '../../db/models/call.model';
import {
  RULE_CALL_KINDS,
  RULE_PARAM_SOURCES,
  RULE_TIMING_MODES,
} from '../../db/models/outcome-rule.model';
import { POSTCALL_STATUSES } from '../../db/models/post-call-message.model';
import { registry } from '../../shared/openapi/registry';
import {
  bearer,
  bearerOrKey,
  errors,
  noContentResponse,
  ok,
  PUBLIC_API_TAG,
} from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

const unique = <T>(a: T[]) => new Set(a).size === a.length;

export const RuleWhenSchema = z.strictObject({
  dispositions: z
    .array(z.string().regex(/^[a-z0-9_]{1,40}$/))
    .max(30)
    .refine(unique, 'Unique')
    .default([]),
  sentiment: z.array(z.enum(SENTIMENTS)).refine(unique, 'Unique').default([]),
  hasPromise: z.boolean().nullable().default(null),
  notAnsweredInARow: z.number().int().min(1).max(10).nullable().default(null),
  callKinds: z.array(z.enum(RULE_CALL_KINDS)).refine(unique, 'Unique').default([]),
  flowIds: z.array(ObjectIdSchema).max(20).default([]),
  campaignIds: z.array(ObjectIdSchema).max(20).default([]),
});

export const RuleParamSchema = z
  .strictObject({
    from: z.enum(RULE_PARAM_SOURCES),
    key: z.string().trim().min(1).max(60).nullable().default(null),
    value: z.string().max(200).nullable().default(null),
  })
  .refine((p) => (p.from === 'text' ? p.value !== null : p.key !== null), {
    message: 'Pick a field (or type a value for text)',
  });

export const RuleTimingSchema = z
  .strictObject({
    mode: z.enum(RULE_TIMING_MODES).default('now'),
    delayMinutes: z
      .number()
      .int()
      .min(1)
      .max(POSTCALL_LIMITS.maxDelayMinutes)
      .nullable()
      .default(null),
  })
  .refine((t) => t.mode !== 'after' || t.delayMinutes !== null, {
    path: ['delayMinutes'],
    message: 'How many minutes after the call?',
  });

const ruleFields = {
  name: z.string().trim().min(1).max(80),
  active: z.boolean().default(true),
  order: z.number().int().min(0).max(1000).default(0),
  when: RuleWhenSchema,
  send: z.strictObject({
    channelId: ObjectIdSchema.nullable().default(null),
    templateId: ObjectIdSchema,
    params: z.array(RuleParamSchema).max(20).default([]),
  }),
  timing: RuleTimingSchema,
};

export const CreateRuleBody = z.strictObject(ruleFields);
export const UpdateRuleBody = z
  .strictObject({
    name: ruleFields.name.optional(),
    active: z.boolean().optional(),
    order: z.number().int().min(0).max(1000).optional(),
    when: RuleWhenSchema.optional(),
    send: ruleFields.send.optional(),
    timing: RuleTimingSchema.optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Change at least one field');
export const RuleParams = z.strictObject({ id: ObjectIdSchema });

export const OutcomeRuleSchema = registry.register(
  'OutcomeRule',
  z.object({
    id: z.string(),
    name: z.string(),
    active: z.boolean(),
    order: z.number().int(),
    when: z.object({
      dispositions: z.array(z.string()),
      sentiment: z.array(z.enum(SENTIMENTS)),
      hasPromise: z.boolean().nullable(),
      notAnsweredInARow: z.number().int().nullable(),
      callKinds: z.array(z.enum(RULE_CALL_KINDS)),
      flowIds: z.array(z.string()),
      campaignIds: z.array(z.string()),
    }),
    send: z.object({
      channelId: z.string().nullable(),
      templateId: z.string(),
      template: z.object({ name: z.string(), language: z.string(), status: z.string() }).nullable(),
      params: z.array(
        z.object({
          from: z.enum(RULE_PARAM_SOURCES),
          key: z.string().nullable(),
          value: z.string().nullable(),
        }),
      ),
    }),
    timing: z.object({
      mode: z.enum(RULE_TIMING_MODES),
      delayMinutes: z.number().int().nullable(),
    }),
    createdAt: z.string(),
  }),
);

export const AfterCallRowSchema = registry.register(
  'AfterCallMessage',
  z.object({
    id: z.string(),
    source: z.enum(['flow', 'rule']),
    nodeId: z.string().nullable(),
    ruleId: z.string().nullable(),
    ruleName: z.string().nullable(),
    templateName: z.string(),
    language: z.string(),
    status: z.enum(POSTCALL_STATUSES),
    reason: z.string().nullable(),
    scheduledAt: z.string(),
    sentAt: z.string().nullable(),
    messageId: z.string().nullable(),
    conversationId: z.string().nullable(),
  }),
);

const tags = ['After the call'];
const base = '/api/v1/outcome-rules';
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'After-the-call rules, in order (integrations.manage)',
  security: bearer,
  responses: { 200: ok(z.array(OutcomeRuleSchema)), 403: errors[403] },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary: `Add a rule (≤ ${String(POSTCALL_LIMITS.rulesPerAccount)} → 422 OUTCOME_RULE_LIMIT)`,
  security: bearer,
  request: json(CreateRuleBody),
  responses: { 201: ok(OutcomeRuleSchema), 403: errors[403], 422: errors[422] },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}`,
  tags,
  summary: 'Change a rule (switch it on / off, reorder, edit)',
  security: bearer,
  request: { params: RuleParams, ...json(UpdateRuleBody) },
  responses: { 200: ok(OutcomeRuleSchema), 403: errors[403], 404: errors[404], 422: errors[422] },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary: 'Remove a rule (messages already scheduled by it are skipped: rule_disabled)',
  security: bearer,
  request: { params: RuleParams },
  responses: { 204: noContentResponse, 403: errors[403], 404: errors[404] },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/calls/{id}/after-call',
  tags: ['Calls', PUBLIC_API_TAG],
  summary: 'WhatsApp messages after this call: sent / scheduled / skipped with the reason',
  security: bearerOrKey,
  request: { params: RuleParams },
  responses: { 200: ok(z.array(AfterCallRowSchema)), 403: errors[403], 404: errors[404] },
});
