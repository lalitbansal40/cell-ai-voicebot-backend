import { FLOW_LIMITS } from '../../config/limits';
import { NODE_GROUPS } from '../../core/engine/catalog';
import {
  FlowEdgeSchema,
  FlowSettingsSchema,
  FlowVariableSchema,
  NODE_CONFIG_SCHEMAS,
  NODE_ID,
} from '../../core/engine/schema';
import { ISSUE_CODES } from '../../core/engine/validate';
import {
  FLOW_STATUSES,
  FLOW_TRIGGERS,
  NODE_TYPES,
  type NodeType,
} from '../../db/models/flow.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok, okPage } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema, PaginationQuerySchema } from '../../shared/validation/schemas';

import { FLOW_TEMPLATES } from './templates';

// ── Graph documentation (typed node union for the frontend) ────────────────

const pascal = (type: string) =>
  type
    .split('_')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');

const typedNode = (type: NodeType) =>
  registry.register(
    `Flow${pascal(type)}Node`,
    z.object({
      id: z.string(),
      type: z.literal(type),
      label: z.string().optional(),
      position: z.object({ x: z.number(), y: z.number() }),
      config: registry.register(`Flow${pascal(type)}Config`, NODE_CONFIG_SCHEMAS[type]),
    }),
  );

const [firstNode, ...otherNodes] = NODE_TYPES.map(typedNode);

/** A node — `config` depends on `type`; drafts may hold incomplete configs (reported as issues). */
export const FlowNodeDocSchema = registry.register(
  'FlowNode',
  z.discriminatedUnion('type', [firstNode!, ...otherNodes]),
);

export const FlowGraphDocSchema = registry.register(
  'FlowGraph',
  z.object({
    schemaVersion: z.literal(1),
    nodes: z.array(FlowNodeDocSchema),
    edges: z.array(registry.register('FlowEdge', FlowEdgeSchema)),
    variables: z.array(registry.register('FlowVariable', FlowVariableSchema)),
    settings: registry.register('FlowSettings', FlowSettingsSchema),
    viewport: z.object({ x: z.number(), y: z.number(), zoom: z.number() }).optional(),
  }),
);

// ── Requests ────────────────────────────────────────────────────────────────

const name = z.string().trim().min(1).max(FLOW_LIMITS.nameMaxChars);
const description = z.string().trim().max(FLOW_LIMITS.descriptionMaxChars).nullable();
const revision = z.number().int().min(1).openapi({ description: 'The revision the client loaded' });

export const FlowParams = z.strictObject({ id: ObjectIdSchema });
export const VersionParams = z.strictObject({
  id: ObjectIdSchema,
  version: z.coerce.number().int().min(1),
});

export const ListFlowsQuery = z.strictObject({
  ...PaginationQuerySchema.shape,
  q: z.string().trim().min(1).max(80).optional(),
  status: z.enum(FLOW_STATUSES).optional(),
});

export const CreateFlowBody = z.strictObject({
  name,
  description: description.optional(),
  templateKey: z.enum(FLOW_TEMPLATES.map((t) => t.key) as [string, ...string[]]).optional(),
  agentIds: z
    .record(z.string().regex(NODE_ID), ObjectIdSchema)
    .optional()
    .openapi({ description: 'Template ai_agent node id → agent id' }),
});

export const UpdateFlowBody = z
  .strictObject({ name, description })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

/** Parsed with `graph` unknown — the service reports graph errors as `graph.<path>`. */
export const SaveDraftBody = z.strictObject({ revision, graph: z.unknown() });
export const ValidateBody = z.strictObject({ graph: z.unknown().optional() });
export const PublishBody = z.strictObject({
  revision,
  notes: z.string().trim().max(FLOW_LIMITS.versionNotesMaxChars).nullable().optional(),
});
export const RestoreBody = z.strictObject({ revision });
export const ExportQuery = z.strictObject({
  version: z
    .union([z.literal('draft'), z.coerce.number().int().min(1)])
    .default('draft')
    .openapi({ description: '`draft` (default) or a version number' }),
});
export const ImportBody = z.strictObject({
  file: z.unknown().openapi({ description: 'The exported JSON (`format: cell-ai-flow`)' }),
  name: name.optional(),
});

// ── Responses ───────────────────────────────────────────────────────────────

export const FlowIssueSchema = registry.register(
  'FlowIssue',
  z.object({
    severity: z.enum(['error', 'warning']),
    code: z.enum(ISSUE_CODES),
    message: z.string(),
    nodeId: z.string().optional(),
    edgeId: z.string().optional(),
    field: z.string().optional(),
  }),
);

const userRef = z.object({ id: z.string(), name: z.string() }).nullable();

export const FlowListItemSchema = registry.register(
  'FlowListItem',
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    status: z.enum(FLOW_STATUSES),
    revision: z.number(),
    publishedVersion: z.number().nullable(),
    hasUnpublishedChanges: z.boolean(),
    nodesCount: z.number(),
    triggers: z.array(z.enum(FLOW_TRIGGERS)),
    agents: z.array(z.object({ id: z.string(), name: z.string() })),
    templateKey: z.string().nullable(),
    updatedBy: userRef,
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const FlowSchema = registry.register(
  'Flow',
  FlowListItemSchema.extend({
    draft: FlowGraphDocSchema.openapi({
      description: 'Secret header values are never returned (only `valueHint`)',
    }),
    issues: z.array(FlowIssueSchema),
    addedVariables: z
      .array(z.string())
      .optional()
      .openapi({ description: 'Create from template: contact fields that became flow variables' }),
  }),
);

export const SaveDraftResultSchema = registry.register(
  'FlowDraftSaved',
  z.object({
    revision: z.number(),
    issues: z.array(FlowIssueSchema),
    hasUnpublishedChanges: z.boolean(),
    savedAt: z.string(),
  }),
);

export const FlowVersionSummarySchema = registry.register(
  'FlowVersionSummary',
  z.object({
    id: z.string(),
    version: z.number(),
    notes: z.string().nullable(),
    checksum: z.string(),
    nodesCount: z.number(),
    current: z.boolean().openapi({ description: 'The latest published version' }),
    publishedBy: userRef,
    publishedAt: z.string(),
  }),
);

export const FlowVersionSchema = registry.register(
  'FlowVersion',
  FlowVersionSummarySchema.extend({ graph: FlowGraphDocSchema }),
);

export const FlowTemplateSchema = registry.register(
  'FlowTemplate',
  z.object({
    key: z.string(),
    title: z.string(),
    description: z.string(),
    language: z.enum(['hi', 'en', 'hinglish']),
    aiNodes: z.array(
      z.object({
        nodeId: z.string(),
        label: z.string(),
        suggestedAgentTemplate: z.string().nullable(),
      }),
    ),
    optionalFields: z.array(z.string()),
  }),
);

export const FlowVariableInfoSchema = registry.register(
  'FlowVariableInfo',
  z.object({
    name: z.string(),
    label: z.string(),
    type: z.enum(['text', 'number', 'boolean', 'date', 'currency', 'phone', 'built_in']),
    source: z.enum(['contact', 'flow', 'system']),
    readOnly: z.boolean(),
  }),
);

const exitSchema = z.object({
  handle: z.string(),
  label: z.string(),
  required: z.boolean(),
  kind: z.enum(['normal', 'error']),
});

export const FlowCatalogSchema = registry.register(
  'FlowCatalog',
  z.object({
    nodes: z.array(
      z.object({
        type: z.enum(NODE_TYPES),
        label: z.string(),
        group: z.enum(NODE_GROUPS),
        description: z.string(),
        waits: z.boolean(),
        staticExits: z.array(exitSchema),
        dynamicExits: z.enum(['keys', 'intents', 'rules']).nullable(),
        defaults: z.record(z.string(), z.unknown()),
      }),
    ),
    groups: z.array(z.enum(NODE_GROUPS)),
    operators: z.array(z.object({ operator: z.string(), needsValue: z.boolean() })),
    dispositions: z.array(z.string()),
    languages: z.array(z.string()),
    speechLanguages: z.array(z.string()),
    voices: z.array(z.string()),
    triggers: z.array(z.string()),
    variableTypes: z.array(z.string()),
    httpMethods: z.array(z.string()),
    systemVariables: z.array(z.object({ name: z.string(), label: z.string(), type: z.string() })),
    limits: z.record(z.string(), z.number()),
  }),
);

export const FlowImportResultSchema = registry.register(
  'FlowImportResult',
  z.object({
    flow: FlowSchema,
    warnings: z.array(z.string()).openapi({
      description:
        '`agent_unmapped:<nodeId>`, `audio_unmapped:<nodeId>`, `secret_removed:<nodeId>.<header>`',
    }),
  }),
);

// ── OpenAPI paths ───────────────────────────────────────────────────────────

const tags = ['Call flows'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const read = { 401: errors[401], 403: errors[403] };
const write = { ...read, 404: errors[404], 409: errors[409], 422: errors[422] };
const byId = { params: FlowParams };
const base = '/api/v1/flows';

registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Call flows of the account (flows.read) — search by name, filter by status',
  security: bearer,
  request: { query: ListFlowsQuery },
  responses: { 200: okPage(FlowListItemSchema), ...read },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary: `Create a flow — blank (Start → Hang up) or from a template (≤ ${String(FLOW_LIMITS.flowsPerAccount)} per account; flows.write)`,
  security: bearer,
  request: json(CreateFlowBody),
  responses: { 201: ok(FlowSchema, 'Created'), ...write },
});
registry.registerPath({
  method: 'get',
  path: `${base}/templates`,
  tags,
  summary: 'Flow templates (Loan recovery, Payment reminder, Feedback survey, Inbound support)',
  security: bearer,
  responses: { 200: ok(z.array(FlowTemplateSchema)), ...read },
});
registry.registerPath({
  method: 'get',
  path: `${base}/catalog`,
  tags,
  summary:
    'Node types with exits, defaults and limits; operators, dispositions, voices, system variables',
  security: bearer,
  responses: { 200: ok(FlowCatalogSchema), ...read },
});
registry.registerPath({
  method: 'post',
  path: `${base}/import`,
  tags,
  summary: `Import an exported flow JSON (≤ ${String(FLOW_LIMITS.importMaxBytes / 1024)} KB) as a NEW flow — agents / audio mapped by id or name, secrets removed (flows.write)`,
  security: bearer,
  request: json(ImportBody),
  responses: {
    201: ok(FlowImportResultSchema, 'Created'),
    ...write,
    413: { description: 'File too large (PAYLOAD_TOO_LARGE)' },
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}`,
  tags,
  summary: 'One flow with its draft graph and current validation issues',
  security: bearer,
  request: byId,
  responses: { 200: ok(FlowSchema), ...read, 404: errors[404] },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}`,
  tags,
  summary: 'Rename / describe a flow (no revision needed)',
  security: bearer,
  request: { ...byId, ...json(UpdateFlowBody) },
  responses: { 200: ok(FlowSchema), ...write },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary:
    'Delete a flow (kept 30 days, then purged) — 409 RESOURCE_IN_USE while a campaign / number uses it',
  security: bearer,
  request: byId,
  responses: { 204: noContentResponse, ...write },
});
registry.registerPath({
  method: 'put',
  path: `${base}/{id}/draft`,
  tags,
  summary:
    'Save the draft graph — 409 FLOW_REVISION_CONFLICT when someone saved since `revision` (details: current revision, updatedBy, updatedAt). Incomplete nodes are saved and reported as issues; structural errors are 422 at `graph.<path>`.',
  security: bearer,
  request: {
    ...byId,
    ...json(z.object({ revision, graph: FlowGraphDocSchema })),
  },
  responses: {
    200: ok(SaveDraftResultSchema),
    ...write,
    413: { description: `Graph larger than ${String(FLOW_LIMITS.graphMaxBytes / 1024)} KB` },
  },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/validate`,
  tags,
  summary: 'Validation issues of the draft (or of a posted graph) — no changes (flows.read)',
  security: bearer,
  request: { ...byId, ...json(z.object({ graph: FlowGraphDocSchema.optional() })) },
  responses: { 200: ok(z.array(FlowIssueSchema)), ...read, 404: errors[404], 422: errors[422] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/publish`,
  tags,
  summary:
    'Publish the draft as a new immutable version (flows.publish) — 422 FLOW_INVALID with `details` = issues when it has errors; 409 when nothing changed since the last version',
  security: bearer,
  request: { ...byId, ...json(PublishBody) },
  responses: { 201: ok(FlowVersionSummarySchema, 'Published'), ...write },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/versions`,
  tags,
  summary: 'Published versions, newest first',
  security: bearer,
  request: byId,
  responses: { 200: ok(z.array(FlowVersionSummarySchema)), ...read, 404: errors[404] },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/versions/{version}`,
  tags,
  summary: 'One published version with its graph',
  security: bearer,
  request: { params: VersionParams },
  responses: { 200: ok(FlowVersionSchema), ...read, 404: errors[404] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/versions/{version}/restore`,
  tags,
  summary: 'Copy a version into the draft (flows.publish) — publish again to roll back',
  security: bearer,
  request: { params: VersionParams, ...json(RestoreBody) },
  responses: { 200: ok(FlowSchema), ...write },
});
for (const [action, summary] of [
  ['duplicate', 'Copy the draft into a new flow ("… (copy)")'],
  ['archive', 'Hide a flow from campaign pickers (pinned campaigns keep working)'],
  ['unarchive', 'Bring an archived flow back'],
] as const) {
  registry.registerPath({
    method: 'post',
    path: `${base}/{id}/${action}`,
    tags,
    summary: `${summary} (flows.write)`,
    security: bearer,
    request: byId,
    responses: {
      [action === 'duplicate' ? 201 : 200]: ok(
        FlowSchema,
        action === 'duplicate' ? 'Created' : 'OK',
      ),
      ...write,
    },
  });
}
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/export`,
  tags,
  summary:
    'Download the draft or a version as JSON (`format: cell-ai-flow`) — secret header values are never exported (flows.write)',
  security: bearer,
  request: { ...byId, query: ExportQuery },
  responses: {
    200: { description: 'The flow JSON file (attachment, no envelope)' },
    ...read,
    404: errors[404],
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/variables`,
  tags,
  summary: 'Variables the flow can use: contact fields, flow variables and system variables',
  security: bearer,
  request: byId,
  responses: { 200: ok(z.array(FlowVariableInfoSchema)), ...read, 404: errors[404] },
});
