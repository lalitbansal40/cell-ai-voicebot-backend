import {
  FlowEdgeSchema,
  FlowSettingsSchema,
  FlowVariableSchema,
  NODE_CONFIG_SCHEMAS,
} from '../../core/engine/schema';
import { NODE_TYPES, type NodeType } from '../../db/models/flow.model';
import { registry } from '../../shared/openapi/registry';
import { z } from '../../shared/openapi/zod';

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
