import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { Env } from '../../config/env';
import { FLOW_LIMITS } from '../../config/limits';
import { outgoingPolicy } from '../../core/ai/ip-guard';
import { seal, secretHint } from '../../core/ai/secret-box';
import { graphChecksum, graphSizeBytes } from '../../core/engine/canonical';
import {
  FlowGraphSchema,
  OBJECT_ID,
  blankGraph,
  parseNodeConfig,
  type FlowGraph,
} from '../../core/engine/schema';
import { validateFlow, type Issue, type ValidateContext } from '../../core/engine/validate';
import { buildVariableCatalog } from '../../core/engine/variables';
import { notifyAccount } from '../../core/realtime/notify';
import { isDuplicateKeyError } from '../../db/errors';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { FlowAudioModel } from '../../db/models/flow-audio.model';
import { FlowVersionModel, type FlowVersionDoc } from '../../db/models/flow-version.model';
import {
  FlowModel,
  FLOW_TRIGGERS,
  type FlowDoc,
  type FlowTrigger,
} from '../../db/models/flow.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import { escapeRegex } from '../../shared/utils/regex';
import { accountVariables } from '../ai-agents/variables';
import { auditRequest } from '../audit/audit.service';

import type { CreateFlowBody, ListFlowsQuery, UpdateFlowBody } from './flows.schema';
import { campaignsUsingFlow } from './in-use';
import { findFlowTemplate } from './templates';

export const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface FlowsDeps {
  env: Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL' | 'MOCK_APIS_ENABLED'>;
  /** Secret box key (sealed API request headers). */
  secretKey: Buffer;
  /** Test hook: extra allowed ports for API request nodes. */
  extraPorts?: readonly number[];
}

const iso = (d: Date) => d.toISOString();
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : []);

// ── Lookups ─────────────────────────────────────────────────────────────────

/** A live flow of the caller's account (404 otherwise, never 403). */
export const findFlow = async (accountId: Types.ObjectId, id: string): Promise<FlowDoc> => {
  const _id = toObjectId(id);
  const flow = _id ? await FlowModel.findOne({ _id, accountId }).lean<FlowDoc>() : null;
  if (!flow) throw new NotFoundError('Flow not found');
  return flow;
};

export const latestVersion = (flowId: Types.ObjectId) =>
  FlowVersionModel.findOne({ flowId })
    .sort({ version: -1 })
    .select({ version: 1, checksum: 1 })
    .lean<Pick<FlowVersionDoc, '_id' | 'version' | 'checksum'>>();

const userNames = async (ids: (Types.ObjectId | null)[]) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const users = unique.length
    ? await UserModel.find({ _id: { $in: unique } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  return new Map(users.map((u) => [u._id.toString(), u.name]));
};

const agentNames = async (accountId: Types.ObjectId, ids: Types.ObjectId[]) => {
  const agents = ids.length
    ? await AiAgentModel.find({ accountId, _id: { $in: ids } })
        .setOptions({ withDeleted: true })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  return new Map(agents.map((a) => [a._id.toString(), a.name]));
};

// ── Graph helpers ───────────────────────────────────────────────────────────

/** Ids of agents / audio a graph references (valid ids only). */
export const graphRefs = (graph: FlowGraph) => {
  const agents = new Set<string>();
  const audios = new Set<string>();
  for (const node of graph.nodes) {
    const c = rec(node.config);
    if (node.type === 'ai_agent' && typeof c.agentId === 'string' && OBJECT_ID.test(c.agentId)) {
      agents.add(c.agentId.toLowerCase());
    }
    if (node.type === 'play_audio' && typeof c.audioId === 'string' && OBJECT_ID.test(c.audioId)) {
      audios.add(c.audioId.toLowerCase());
    }
    const prompt = rec(c.prompt);
    if (
      prompt.kind === 'audio' &&
      typeof prompt.audioId === 'string' &&
      OBJECT_ID.test(prompt.audioId)
    ) {
      audios.add(prompt.audioId.toLowerCase());
    }
  }
  return {
    agents: [...agents].map((id) => new Types.ObjectId(id)),
    audios: [...audios].map((id) => new Types.ObjectId(id)),
  };
};

export const graphStats = (graph: FlowGraph) => {
  const start = graph.nodes.find((n) => n.type === 'start');
  const parsed = start ? parseNodeConfig('start', start.config) : null;
  const triggers: FlowTrigger[] = parsed?.ok
    ? parsed.config.triggers
    : start
      ? [...FLOW_TRIGGERS]
      : [];
  return { nodes: graph.nodes.length, ...graphRefs(graph), triggers };
};

/** Structural parse of a posted graph — 422 at `graph.<path>`, 413 when too large. */
export const parseGraph = (raw: unknown, prefix = 'graph'): FlowGraph => {
  const result = FlowGraphSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.slice(0, 50).map((i) => ({
        path: [prefix, ...i.path.map(String)].join('.'),
        message: i.message,
      })),
    );
  }
  if (graphSizeBytes(result.data) > FLOW_LIMITS.graphMaxBytes) {
    throw new AppError('PAYLOAD_TOO_LARGE', 'The flow is too large.');
  }
  return result.data;
};

/**
 * Seals secret API headers. A secret header sent with `value: null` keeps the
 * sealed value stored for the same node + header name. Client `sealed` /
 * `valueHint` values are never trusted.
 */
export const sealGraph = (graph: FlowGraph, previous: unknown, key: Buffer): FlowGraph => {
  const before = new Map(
    list(rec(previous).nodes).map((n) => [String(n.id), list(rec(n.config).headers)]),
  );
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.type !== 'api_request' || !Array.isArray(node.config.headers)) return node;
      const old = before.get(node.id) ?? [];
      const headers = list(node.config.headers).map((h) => {
        const { sealed: _s, valueHint: _v, ...rest } = h;
        if (rest.secret !== true) return rest;
        if (typeof rest.value === 'string' && rest.value !== '') {
          return {
            ...rest,
            value: null,
            sealed: seal(key, rest.value),
            valueHint: secretHint(rest.value),
          };
        }
        const kept = old.find(
          (o) =>
            o.secret === true &&
            typeof o.sealed === 'string' &&
            String(o.name).toLowerCase() === String(rest.name).toLowerCase(),
        );
        return kept
          ? { ...rest, value: null, sealed: kept.sealed, valueHint: kept.valueHint }
          : { ...rest, value: null };
      });
      return { ...node, config: { ...node.config, headers } };
    }),
  };
};

/** Graph for API responses / exports: sealed values never leave the server. */
export const publicGraph = (graph: unknown, keepHints = true): FlowGraph => {
  const g = graph as FlowGraph;
  return {
    ...g,
    nodes: g.nodes.map((node) => {
      if (node.type !== 'api_request' || !Array.isArray(node.config.headers)) return node;
      const headers = list(node.config.headers).map((h) => {
        const { sealed: _s, valueHint, ...rest } = h;
        return rest.secret === true && keepHints && typeof valueHint === 'string'
          ? { ...rest, value: null, valueHint }
          : rest.secret === true
            ? { ...rest, value: null }
            : rest;
      });
      return { ...node, config: { ...node.config, headers } };
    }),
  };
};

/** Context for `validateFlow` from the live account data. */
export const validationContext = async (
  accountId: Types.ObjectId,
  graph: FlowGraph,
  deps: Pick<FlowsDeps, 'env' | 'extraPorts'>,
): Promise<ValidateContext> => {
  const refs = graphRefs(graph);
  const [contactVars, agents, audios] = await Promise.all([
    accountVariables(accountId),
    refs.agents.length
      ? AiAgentModel.find({ accountId, _id: { $in: refs.agents } })
          .select({ isActive: 1 })
          .lean<{ _id: Types.ObjectId; isActive: boolean }[]>()
      : [],
    refs.audios.length
      ? FlowAudioModel.find({ accountId, _id: { $in: refs.audios } })
          .select({ _id: 1 })
          .lean<{ _id: Types.ObjectId }[]>()
      : [],
  ]);
  return {
    contactVars,
    agents: new Map(agents.map((a) => [a._id.toString(), { active: a.isActive }])),
    audios: new Set(audios.map((a) => a._id.toString())),
    urlPolicy: outgoingPolicy(deps.env, deps.extraPorts),
  };
};

export const issuesOf = async (
  accountId: Types.ObjectId,
  graph: FlowGraph,
  deps: Pick<FlowsDeps, 'env' | 'extraPorts'>,
): Promise<Issue[]> => validateFlow(graph, await validationContext(accountId, graph, deps));

/** `FLOW_INVALID` with the issues as details. */
export const flowInvalid = (issues: Issue[]): AppError => {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  return new AppError(
    'FLOW_INVALID',
    `The call flow has ${String(errorCount)} problem${errorCount === 1 ? '' : 's'} to fix before publishing.`,
    issues.map((i) => ({
      path: i.field ?? (i.nodeId ? `nodes.${i.nodeId}` : i.edgeId ? `edges.${i.edgeId}` : 'graph'),
      message: i.message,
      issue: i.code,
      severity: i.severity,
      ...(i.nodeId ? { nodeId: i.nodeId } : {}),
      ...(i.edgeId ? { edgeId: i.edgeId } : {}),
    })),
  );
};

// ── Views ───────────────────────────────────────────────────────────────────

const toListItem = (f: FlowDoc, agents: Map<string, string>, users: Map<string, string>) => ({
  id: f._id.toString(),
  name: f.name,
  description: f.description ?? null,
  status: f.status,
  revision: f.revision,
  publishedVersion: f.publishedVersion ?? null,
  hasUnpublishedChanges: f.hasUnpublishedChanges,
  nodesCount: f.stats.nodes,
  triggers: f.stats.triggers,
  agents: f.stats.agents
    .map((id) => ({ id: id.toString(), name: agents.get(id.toString()) ?? '' }))
    .filter((a) => a.name),
  templateKey: f.templateKey ?? null,
  updatedBy: f.updatedBy
    ? { id: f.updatedBy.toString(), name: users.get(f.updatedBy.toString()) ?? '' }
    : null,
  createdAt: iso(f.createdAt),
  updatedAt: iso(f.updatedAt),
});

export const toFlowView = async (
  f: FlowDoc,
  deps: Pick<FlowsDeps, 'env' | 'extraPorts'>,
  extra: { addedVariables?: string[] } = {},
) => {
  const [agents, users] = await Promise.all([
    agentNames(f.accountId, f.stats.agents),
    userNames([f.updatedBy]),
  ]);
  const draft = f.draft as unknown as FlowGraph;
  return {
    ...toListItem(f, agents, users),
    draft: publicGraph(draft),
    issues: await issuesOf(f.accountId, draft, deps),
    ...extra,
  };
};

export const notifyFlowUpdated = (
  f: Pick<FlowDoc, '_id' | 'accountId' | 'revision'>,
  by: string | null | undefined,
) =>
  notifyAccount(f.accountId.toString(), 'flow.updated', {
    flowId: f._id.toString(),
    revision: f.revision,
    by: by ?? null,
  });

// ── Names & limits ──────────────────────────────────────────────────────────

const nameTaken = async (accountId: Types.ObjectId, name: string, exceptId?: Types.ObjectId) =>
  Boolean(
    await FlowModel.findOne({ accountId, name, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
      .collation(NAME_COLLATION)
      .select({ _id: 1 })
      .lean(),
  );

const duplicateName = () =>
  new ConflictError('CONFLICT_DUPLICATE', 'A flow with this name already exists.', [
    { path: 'name', message: 'Already exists' },
  ]);

/** `base<first>`, then `base<suffix(2)>`, `base<suffix(3)>` … (≤ 80 chars). */
export const freeName = async (
  accountId: Types.ObjectId,
  base: string,
  suffix: (n: number) => string = (n) => ` (${String(n)})`,
  first = '',
) => {
  const fit = (end: string) => `${base.slice(0, FLOW_LIMITS.nameMaxChars - end.length)}${end}`;
  if (!(await nameTaken(accountId, fit(first)))) return fit(first);
  for (let n = 2; ; n += 1) {
    const name = fit(suffix(n));
    if (!(await nameTaken(accountId, name))) return name;
  }
};

export const assertFlowLimit = async (accountId: Types.ObjectId) => {
  if ((await FlowModel.countDocuments({ accountId })) >= FLOW_LIMITS.flowsPerAccount) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${String(FLOW_LIMITS.flowsPerAccount)} flows.`,
    );
  }
};

/** Inserts a new flow (draft only) — shared by create, duplicate and import. */
export const insertFlow = async (
  req: Request,
  input: { name: string; description: string | null; graph: FlowGraph; templateKey: string | null },
): Promise<FlowDoc> => {
  const { accountId } = tenantFilter(req);
  const userId = new Types.ObjectId(requireAuth(req).userId);
  const graph = input.graph as unknown as Record<string, unknown>;
  try {
    const doc = await FlowModel.create({
      accountId,
      name: input.name,
      description: input.description,
      draft: graph,
      draftChecksum: graphChecksum(graph),
      templateKey: input.templateKey,
      stats: graphStats(input.graph),
      createdBy: userId,
      updatedBy: userId,
    });
    return doc.toObject({ transform: false });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
};

// ── CRUD ────────────────────────────────────────────────────────────────────

export const listFlows = async (req: Request, query: z.infer<typeof ListFlowsQuery>) => {
  const { accountId } = tenantFilter(req);
  const filter: Record<string, unknown> = { accountId };
  if (query.q) filter.name = { $regex: escapeRegex(query.q), $options: 'i' };
  if (query.status) filter.status = query.status;
  const [flows, total] = await Promise.all([
    FlowModel.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .select({ draft: 0 })
      .lean<FlowDoc[]>(),
    FlowModel.countDocuments(filter),
  ]);
  const [agents, users] = await Promise.all([
    agentNames(
      accountId,
      flows.flatMap((f) => f.stats.agents),
    ),
    userNames(flows.map((f) => f.updatedBy)),
  ]);
  return {
    items: flows.map((f) => toListItem(f, agents, users)),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

export const getFlow = async (req: Request, id: string, deps: FlowsDeps) =>
  toFlowView(await findFlow(tenantFilter(req).accountId, id), deps);

/** Template graph with the chosen agents and flow variables for missing contact fields. */
export const templateGraph = async (
  accountId: Types.ObjectId,
  key: string,
  agentIds: Record<string, string>,
  deps: { env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'> },
) => {
  const template = findFlowTemplate(key);
  if (!template) throw new ValidationError([{ path: 'templateKey', message: 'Unknown template' }]);
  const raw = template.graph(deps.env) as {
    nodes: { id: string; type: string; config: Record<string, unknown> }[];
    variables: { name: string; type: string }[];
  };
  const aiNodes = new Set(template.aiNodes.map((n) => n.nodeId));
  const details: ErrorDetail[] = [];
  for (const [nodeId, agentId] of Object.entries(agentIds)) {
    if (!aiNodes.has(nodeId))
      details.push({
        path: `agentIds.${nodeId}`,
        message: 'Not an AI agent node of this template',
      });
    else if (!(await AiAgentModel.exists({ accountId, _id: agentId }))) {
      details.push({ path: `agentIds.${nodeId}`, message: 'Agent not found' });
    }
  }
  if (details.length) throw new ValidationError(details);
  const contact = new Set((await accountVariables(accountId)).map((v) => v.name));
  const addedVariables = template.optionalFields.filter((f) => !contact.has(f.name));
  raw.nodes = raw.nodes.map((n) =>
    agentIds[n.id] ? { ...n, config: { ...n.config, agentId: agentIds[n.id] } } : n,
  );
  raw.variables = [
    ...addedVariables.map((f) => ({ name: f.name, type: f.type })),
    ...raw.variables,
  ];
  return { graph: parseGraph(raw), addedVariables: addedVariables.map((f) => f.name) };
};

export const createFlow = async (
  req: Request,
  body: z.infer<typeof CreateFlowBody>,
  deps: FlowsDeps,
) => {
  const { accountId } = tenantFilter(req);
  await assertFlowLimit(accountId);
  if (await nameTaken(accountId, body.name)) throw duplicateName();
  const fromTemplate = body.templateKey
    ? await templateGraph(accountId, body.templateKey, body.agentIds ?? {}, deps)
    : null;
  if (!body.templateKey && body.agentIds && Object.keys(body.agentIds).length) {
    throw new ValidationError([{ path: 'agentIds', message: 'Only used with a template' }]);
  }
  const flow = await insertFlow(req, {
    name: body.name,
    description: body.description ?? null,
    graph: fromTemplate?.graph ?? blankGraph(),
    templateKey: body.templateKey ?? null,
  });
  await auditRequest(req, 'flow.created', {
    target: { type: 'flow', id: flow._id.toString() },
    meta: {
      name: flow.name,
      source: body.templateKey ? 'template' : 'blank',
      templateKey: body.templateKey ?? null,
    },
  });
  notifyFlowUpdated(flow, requireAuth(req).userId);
  return toFlowView(
    flow,
    deps,
    fromTemplate ? { addedVariables: fromTemplate.addedVariables } : {},
  );
};

export const updateFlow = async (
  req: Request,
  id: string,
  patch: z.infer<typeof UpdateFlowBody>,
  deps: FlowsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, id);
  if (patch.name !== undefined && (await nameTaken(accountId, patch.name, flow._id))) {
    throw duplicateName();
  }
  const fields = Object.keys(patch);
  let updated: FlowDoc | null;
  try {
    updated = await FlowModel.findOneAndUpdate(
      { _id: flow._id, accountId },
      { $set: { ...patch, updatedBy: new Types.ObjectId(requireAuth(req).userId) } },
      { returnDocument: 'after' },
    ).lean<FlowDoc>();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
  if (!updated) throw new NotFoundError('Flow not found');
  await auditRequest(req, 'flow.updated', {
    target: { type: 'flow', id: flow._id.toString() },
    meta: { fields },
  });
  notifyFlowUpdated(updated, requireAuth(req).userId);
  return toFlowView(updated, deps);
};

/** 409 `FLOW_REVISION_CONFLICT` with the current revision and who saved it. */
export const revisionConflict = async (flowId: Types.ObjectId): Promise<AppError> => {
  const current = await FlowModel.findById(flowId)
    .select({ revision: 1, updatedBy: 1, updatedAt: 1 })
    .lean<Pick<FlowDoc, 'revision' | 'updatedBy' | 'updatedAt'>>();
  if (!current) return new NotFoundError('Flow not found');
  const users = await userNames([current.updatedBy]);
  return new ConflictError('FLOW_REVISION_CONFLICT', undefined, [
    { path: 'revision', message: String(current.revision) },
    {
      path: 'updatedBy',
      message: current.updatedBy ? (users.get(current.updatedBy.toString()) ?? '') : '',
    },
    { path: 'updatedAt', message: iso(current.updatedAt) },
  ]);
};

export const saveDraft = async (
  req: Request,
  id: string,
  body: { revision: number; graph: unknown },
  deps: FlowsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const userId = requireAuth(req).userId;
  const flow = await findFlow(accountId, id);
  const graph = sealGraph(parseGraph(body.graph), flow.draft, deps.secretKey);
  const plain = graph as unknown as Record<string, unknown>;
  const checksum = graphChecksum(plain);
  const latest = await latestVersion(flow._id);
  const hasUnpublishedChanges = !latest || latest.checksum !== checksum;
  const updated = await FlowModel.findOneAndUpdate(
    { _id: flow._id, accountId, revision: body.revision },
    {
      $set: {
        draft: plain,
        draftChecksum: checksum,
        stats: graphStats(graph),
        hasUnpublishedChanges,
        updatedBy: new Types.ObjectId(userId),
      },
      $inc: { revision: 1 },
    },
    { returnDocument: 'after' },
  ).lean<FlowDoc>();
  if (!updated) throw await revisionConflict(flow._id);
  notifyFlowUpdated(updated, userId);
  return {
    revision: updated.revision,
    issues: await issuesOf(accountId, graph, deps),
    hasUnpublishedChanges,
    savedAt: iso(updated.updatedAt),
  };
};

export const validateDraft = async (req: Request, id: string, raw: unknown, deps: FlowsDeps) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, id);
  const graph = raw === undefined ? (flow.draft as unknown as FlowGraph) : parseGraph(raw);
  return issuesOf(accountId, sealGraph(graph, flow.draft, deps.secretKey), deps);
};

export const duplicateFlow = async (req: Request, id: string, deps: FlowsDeps) => {
  const { accountId } = tenantFilter(req);
  const source = await findFlow(accountId, id);
  await assertFlowLimit(accountId);
  const name = await freeName(accountId, source.name, (n) => ` (copy ${String(n)})`, ' (copy)');
  const flow = await insertFlow(req, {
    name,
    description: source.description ?? null,
    graph: source.draft as unknown as FlowGraph,
    templateKey: source.templateKey ?? null,
  });
  const target = { type: 'flow', id: flow._id.toString() };
  await auditRequest(req, 'flow.created', { target, meta: { name, source: 'duplicate' } });
  await auditRequest(req, 'flow.duplicated', {
    target,
    meta: { sourceFlowId: source._id.toString(), name },
  });
  notifyFlowUpdated(flow, requireAuth(req).userId);
  return toFlowView(flow, deps);
};

export const setArchived = async (req: Request, id: string, archived: boolean, deps: FlowsDeps) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, id);
  if ((flow.status === 'archived') === archived) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      archived ? 'This flow is already archived.' : 'This flow is not archived.',
    );
  }
  const status = archived ? 'archived' : flow.publishedVersion ? 'published' : 'draft';
  const updated = await FlowModel.findOneAndUpdate(
    { _id: flow._id, accountId },
    { $set: { status, updatedBy: new Types.ObjectId(requireAuth(req).userId) } },
    { returnDocument: 'after' },
  ).lean<FlowDoc>();
  if (!updated) throw new NotFoundError('Flow not found');
  await auditRequest(req, archived ? 'flow.archived' : 'flow.unarchived', {
    target: { type: 'flow', id: flow._id.toString() },
  });
  notifyFlowUpdated(updated, requireAuth(req).userId);
  return toFlowView(updated, deps);
};

export const deleteFlow = async (req: Request, id: string): Promise<void> => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, id);
  const campaigns = await campaignsUsingFlow(flow._id);
  if (campaigns.length) {
    throw new ConflictError(
      'RESOURCE_IN_USE',
      `This flow is used by ${String(campaigns.length)} campaign${campaigns.length === 1 ? '' : 's'}. Cancel or finish them first.`,
      campaigns.map((c) => ({ path: 'campaigns', message: c.name, id: c.id })),
    );
  }
  await FlowModel.updateOne({ _id: flow._id, accountId }, { $set: { deletedAt: new Date() } });
  await auditRequest(req, 'flow.deleted', {
    target: { type: 'flow', id: flow._id.toString() },
    meta: { name: flow.name },
  });
  notifyFlowUpdated(flow, requireAuth(req).userId);
};

export const flowVariables = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, id);
  const draft = flow.draft as unknown as FlowGraph;
  return buildVariableCatalog({
    contactVars: await accountVariables(accountId),
    flowVars: Array.isArray(draft.variables) ? draft.variables : [],
  });
};
