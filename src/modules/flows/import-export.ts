import type { Request } from 'express';
import type { Types } from 'mongoose';

import { FLOW_LIMITS } from '../../config/limits';
import { OBJECT_ID, type FlowGraph } from '../../core/engine/schema';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { FlowAudioModel } from '../../db/models/flow-audio.model';
import { FlowVersionModel, type FlowVersionDoc } from '../../db/models/flow-version.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { z } from '../../shared/openapi/zod';
import { auditRequest } from '../audit/audit.service';

import {
  NAME_COLLATION,
  assertFlowLimit,
  findFlow,
  freeName,
  graphRefs,
  insertFlow,
  notifyFlowUpdated,
  parseGraph,
  publicGraph,
  toFlowView,
  type FlowsDeps,
} from './flows.service';

export const EXPORT_FORMAT = 'cell-ai-flow';

const refList = z
  .array(z.strictObject({ id: z.string().max(40), name: z.string().max(200) }))
  .max(FLOW_LIMITS.nodesMax)
  .default([]);

const ExportFileSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.literal(1),
  exportedAt: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(FLOW_LIMITS.nameMaxChars),
  description: z.string().trim().max(FLOW_LIMITS.descriptionMaxChars).nullable().optional(),
  graph: z.unknown(),
  refs: z.strictObject({ agents: refList, audios: refList }).optional(),
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** True when any object key anywhere is `__proto__` / `constructor` / `prototype`. */
export const hasForbiddenKeys = (value: unknown, depth = 0): boolean => {
  if (depth > 40) return true;
  if (Array.isArray(value)) return value.some((v) => hasForbiddenKeys(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.keys(value).some(
      (k) =>
        FORBIDDEN_KEYS.has(k) || hasForbiddenKeys((value as Record<string, unknown>)[k], depth + 1),
    );
  }
  return false;
};

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'flow';

/** `GET /flows/:id/export` — the draft or a version; secret header values never leave. */
export const exportFlow = async (req: Request, id: string, version: 'draft' | number) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, id);
  let graph: FlowGraph;
  if (version === 'draft') {
    graph = flow.draft as unknown as FlowGraph;
  } else {
    const v = await FlowVersionModel.findOne({
      flowId: flow._id,
      accountId,
      version,
    }).lean<FlowVersionDoc>();
    if (!v) throw new NotFoundError('Version not found');
    graph = v.graph as unknown as FlowGraph;
  }
  const refs = graphRefs(graph);
  const [agents, audios] = await Promise.all([
    AiAgentModel.find({ accountId, _id: { $in: refs.agents } })
      .setOptions({ withDeleted: true })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
    FlowAudioModel.find({ accountId, _id: { $in: refs.audios } })
      .setOptions({ withDeleted: true })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
  ]);
  await auditRequest(req, 'flow.exported', {
    target: { type: 'flow', id: flow._id.toString() },
    meta: { version },
  });
  return {
    fileName: `flow-${slug(flow.name)}-${version === 'draft' ? 'draft' : `v${String(version)}`}.json`,
    body: {
      format: EXPORT_FORMAT,
      schemaVersion: 1 as const,
      exportedAt: new Date().toISOString(),
      name: flow.name,
      description: flow.description ?? null,
      graph: publicGraph(graph, false),
      refs: {
        agents: agents.map((a) => ({ id: a._id.toString(), name: a.name })),
        audios: audios.map((a) => ({ id: a._id.toString(), name: a.name })),
      },
    },
  };
};

type RefKind = 'agent' | 'audio';

/** Same-account id → kept; else same name (case-insensitive) → that id; else `null`. */
const remapper = (
  accountId: Types.ObjectId,
  refs: { id: string; name: string }[],
  kind: RefKind,
) => {
  const names = new Map(refs.map((r) => [r.id.toLowerCase(), r.name]));
  const cache = new Map<string, string | null>();
  return async (id: string): Promise<string | null> => {
    const key = id.toLowerCase();
    if (cache.has(key)) return cache.get(key) ?? null;
    const model = kind === 'agent' ? AiAgentModel : FlowAudioModel;
    let mapped: string | null = null;
    if (
      OBJECT_ID.test(id) &&
      (await (model as typeof AiAgentModel).exists({ accountId, _id: id }))
    ) {
      mapped = id;
    } else {
      const name = names.get(key);
      const byName = name
        ? await (model as typeof AiAgentModel)
            .findOne({ accountId, name })
            .collation(NAME_COLLATION)
            .select({ _id: 1 })
            .lean<{ _id: Types.ObjectId }>()
        : null;
      mapped = byName ? byName._id.toString() : null;
    }
    cache.set(key, mapped);
    return mapped;
  };
};

/** `POST /flows/import` — always a new flow. */
export const importFlow = async (
  req: Request,
  body: { file: unknown; name?: string | undefined },
  deps: FlowsDeps,
) => {
  const { accountId } = tenantFilter(req);
  if (Buffer.byteLength(JSON.stringify(body.file ?? null), 'utf8') > FLOW_LIMITS.importMaxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'The file is too large.');
  }
  if (hasForbiddenKeys(body.file)) {
    throw new ValidationError([{ path: 'file', message: 'The file contains forbidden keys' }]);
  }
  const parsed = ExportFileSchema.safeParse(body.file);
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.slice(0, 50).map((i) => ({
        path: ['file', ...i.path.map(String)].join('.'),
        message: i.message,
      })),
    );
  }
  const file = parsed.data;
  const graph = parseGraph(file.graph, 'file.graph');
  await assertFlowLimit(accountId);

  const warnings: string[] = [];
  const agentOf = remapper(accountId, file.refs?.agents ?? [], 'agent');
  const audioOf = remapper(accountId, file.refs?.audios ?? [], 'audio');
  const nodes = [];
  for (const node of graph.nodes) {
    const config = { ...node.config };
    if (node.type === 'ai_agent' && typeof config.agentId === 'string' && config.agentId) {
      const mapped = await agentOf(config.agentId);
      if (!mapped) warnings.push(`agent_unmapped:${node.id}`);
      config.agentId = mapped ?? '';
    }
    if (node.type === 'play_audio' && typeof config.audioId === 'string' && config.audioId) {
      const mapped = await audioOf(config.audioId);
      if (!mapped) warnings.push(`audio_unmapped:${node.id}`);
      config.audioId = mapped ?? '';
    }
    const prompt = config.prompt as Record<string, unknown> | undefined;
    if (prompt && prompt.kind === 'audio' && typeof prompt.audioId === 'string' && prompt.audioId) {
      const mapped = await audioOf(prompt.audioId);
      if (!mapped) warnings.push(`audio_unmapped:${node.id}`);
      config.prompt = { ...prompt, audioId: mapped ?? '' };
    }
    if (node.type === 'api_request' && Array.isArray(config.headers)) {
      config.headers = (config.headers as Record<string, unknown>[]).map((h) => {
        const { sealed: _s, valueHint: _v, ...rest } = h;
        if (rest.secret === true) {
          warnings.push(`secret_removed:${node.id}.${String(rest.name)}`);
          return { ...rest, value: null };
        }
        return rest;
      });
    }
    nodes.push({ ...node, config });
  }
  const name = await freeName(accountId, body.name ?? file.name);
  const flow = await insertFlow(req, {
    name,
    description: file.description ?? null,
    graph: { ...graph, nodes },
    templateKey: null,
  });
  const target = { type: 'flow', id: flow._id.toString() };
  await auditRequest(req, 'flow.created', { target, meta: { name, source: 'import' } });
  await auditRequest(req, 'flow.imported', { target, meta: { name, warnings: warnings.length } });
  notifyFlowUpdated(flow, requireAuth(req).userId);
  return { flow: await toFlowView(flow, deps), warnings };
};
