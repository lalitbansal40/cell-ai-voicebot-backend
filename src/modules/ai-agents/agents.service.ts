import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { Env } from '../../config/env';
import { AI_LIMITS } from '../../config/limits';
import { usageKeys } from '../../core/ai/budget';
import { compileAgent, variablesIn } from '../../core/ai/compile';
import type { AiProvider } from '../../core/ai/types';
import { notifyAccount } from '../../core/realtime/notify';
import { isDuplicateKeyError } from '../../db/errors';
import { AccountModel } from '../../db/models/account.model';
import { AgentUsageModel } from '../../db/models/agent-usage.model';
import {
  AGENT_LANGUAGES,
  AGENT_VOICES,
  AiAgentModel,
  BUILT_IN_TOOLS,
  DISPOSITIONS,
  TONE_TRIGGERS,
  type AgentFunction,
  type AiAgentDoc,
} from '../../db/models/ai-agent.model';
import { KnowledgeBaseModel } from '../../db/models/knowledge-base.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import { escapeRegex } from '../../shared/utils/regex';
import { auditRequest } from '../audit/audit.service';
import { accountTimezone } from '../wallet/wallet.service';

import type {
  CompilePreviewBody,
  CreateAgentBody,
  ListAgentsQuery,
  UpdateAgentBody,
} from './agents.schema';
import { agentTemplates, findTemplate } from './templates';
import { accountVariables, contactVariables, manualVariables } from './variables';

export const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface AgentsDeps {
  env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED' | 'AI_TEXT_MODELS' | 'OPENAI_TEXT_MODEL'>;
  provider: Pick<AiProvider, 'name'>;
}

const iso = (d: Date) => d.toISOString();

export const toFunctionView = (f: AgentFunction) => ({
  id: f._id.toString(),
  name: f.name,
  description: f.description,
  parameters: f.parameters.map((p) => ({
    name: p.name,
    type: p.type,
    description: p.description,
    required: p.required,
    ...(p.type === 'enum' ? { enumValues: p.enumValues ?? [] } : {}),
  })),
  method: f.method,
  url: f.url,
  // secret values never leave the server — only their hint
  headers: f.headers.map((h) => ({
    name: h.name,
    secret: h.secret,
    value: h.secret ? null : (h.value ?? null),
    valueHint: h.secret ? (h.valueHint ?? null) : null,
  })),
  bodyTemplate: f.bodyTemplate ?? null,
  resultPath: f.resultPath ?? null,
  responseHint: f.responseHint ?? null,
  timeoutMs: f.timeoutMs,
});

export const toAgentView = (a: AiAgentDoc) => ({
  id: a._id.toString(),
  name: a.name,
  description: a.description ?? null,
  persona: a.persona,
  openingLine: a.openingLine,
  closingLine: a.closingLine,
  isActive: a.isActive,
  templateKey: a.templateKey ?? null,
  allowedVariables: a.allowedVariables,
  voice: a.voice,
  languageMode: a.languageMode,
  language: a.language,
  toneRules: a.toneRules.map((r) => ({
    when: r.when,
    customWhen: r.customWhen ?? null,
    respond: r.respond,
  })),
  callBehaviour: { ...a.callBehaviour },
  model: { ...a.model },
  limits: { ...a.limits },
  guardrails: { ...a.guardrails, neverSay: [...a.guardrails.neverSay] },
  fallback: { ...a.fallback },
  knowledge: {
    knowledgeBaseIds: a.knowledge.knowledgeBaseIds.map((id) => id.toString()),
    topK: a.knowledge.topK,
    minScoreHundredths: a.knowledge.minScoreHundredths,
  },
  functions: a.functions.map(toFunctionView),
  builtInTools: {
    endCall: { enabled: a.builtInTools.endCall.enabled },
    transferToHuman: {
      enabled: a.builtInTools.transferToHuman.enabled,
      phone: a.builtInTools.transferToHuman.phone ?? null,
      message: a.builtInTools.transferToHuman.message ?? null,
    },
    setDisposition: {
      ...a.builtInTools.setDisposition,
      allowed: [...a.builtInTools.setDisposition.allowed],
    },
    scheduleCallback: { ...a.builtInTools.scheduleCallback },
    savePromiseToPay: { ...a.builtInTools.savePromiseToPay },
    sendSmsAfterCall: {
      enabled: a.builtInTools.sendSmsAfterCall.enabled,
      templates: a.builtInTools.sendSmsAfterCall.templates.map((t) => ({
        key: t.key,
        text: t.text,
      })),
    },
  },
  createdAt: iso(a.createdAt),
  updatedAt: iso(a.updatedAt),
});

/** Loads an agent of the caller's account (404 otherwise, never 403). */
export const findAgent = async (accountId: Types.ObjectId, id: string): Promise<AiAgentDoc> => {
  const _id = toObjectId(id);
  const agent = _id ? await AiAgentModel.findOne({ _id, accountId }).lean<AiAgentDoc>() : null;
  if (!agent) throw new NotFoundError('Agent not found');
  return agent;
};

const duplicateName = () =>
  new ConflictError('CONFLICT_DUPLICATE', 'An agent with this name already exists.', [
    { path: 'name', message: 'Already exists' },
  ]);

const nameTaken = async (accountId: Types.ObjectId, name: string, exceptId?: Types.ObjectId) =>
  Boolean(
    await AiAgentModel.findOne({ accountId, name, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
      .collation(NAME_COLLATION)
      .select({ _id: 1 })
      .lean(),
  );

/** Texts whose `{{variables}}` must be allowed. */
const templatedTexts = (
  a: Pick<
    AiAgentDoc,
    'persona' | 'openingLine' | 'closingLine' | 'guardrails' | 'fallback' | 'toneRules'
  >,
) =>
  [
    ['persona', a.persona],
    ['openingLine', a.openingLine],
    ['closingLine', a.closingLine],
    ['guardrails.disclosureLine', a.guardrails.disclosureLine],
    ['fallback.aiFailed', a.fallback.aiFailed],
    ['fallback.walletEmpty', a.fallback.walletEmpty],
    ['fallback.agentOff', a.fallback.agentOff],
    ['fallback.capReached', a.fallback.capReached],
    ...a.toneRules.map((r, i) => [`toneRules.${i}.respond`, r.respond]),
  ] as const;

/** Cross-field checks the zod schema can't do (variables, models, knowledge bases). */
export const validateAgent = async (
  accountId: Types.ObjectId,
  agent: Pick<
    AiAgentDoc,
    | 'persona'
    | 'openingLine'
    | 'closingLine'
    | 'guardrails'
    | 'fallback'
    | 'toneRules'
    | 'allowedVariables'
    | 'model'
    | 'knowledge'
  >,
  env: AgentsDeps['env'],
): Promise<void> => {
  const details: ErrorDetail[] = [];
  const known = new Set((await accountVariables(accountId)).map((v) => v.name));
  agent.allowedVariables.forEach((name, i) => {
    if (!known.has(name))
      details.push({ path: `allowedVariables.${i}`, message: `Unknown contact field "${name}"` });
  });
  const allowed = new Set([...agent.allowedVariables, 'company']);
  for (const [path, value] of templatedTexts(agent)) {
    const bad = [...new Set(variablesIn(value))].filter((v) => !allowed.has(v));
    if (bad.length) {
      details.push({
        path,
        message: `Not allowed here: ${bad.map((b) => `{{${b}}}`).join(', ')} — add them to the allowed variables`,
      });
    }
  }
  if (!env.AI_TEXT_MODELS.includes(agent.model.textModel)) {
    details.push({ path: 'model.textModel', message: 'Choose one of the available models' });
  }
  const ids = agent.knowledge.knowledgeBaseIds;
  if (ids.length) {
    const found = await KnowledgeBaseModel.countDocuments({ accountId, _id: { $in: ids } });
    if (found !== new Set(ids.map(String)).size) {
      details.push({ path: 'knowledge.knowledgeBaseIds', message: 'Unknown knowledge base' });
    }
  }
  if (details.length) throw new ValidationError(details);
};

const notifyChanged = (accountId: Types.ObjectId, agentId: Types.ObjectId) =>
  notifyAccount(accountId.toString(), 'agent.updated', { agentId: agentId.toString() });

export const listAgents = async (req: Request, query: z.infer<typeof ListAgentsQuery>) => {
  const { accountId } = tenantFilter(req);
  const filter: Record<string, unknown> = { accountId };
  if (query.q) filter.name = { $regex: escapeRegex(query.q), $options: 'i' };
  if (query.activeOnly) filter.isActive = true;
  const [agents, total] = await Promise.all([
    AiAgentModel.find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<AiAgentDoc[]>(),
    AiAgentModel.countDocuments(filter),
  ]);
  const { month } = usageKeys(new Date(), await accountTimezone(accountId));
  const spend = await AgentUsageModel.aggregate<{ _id: Types.ObjectId; spent: number }>([
    { $match: { accountId, month, agentId: { $in: agents.map((a) => a._id) } } },
    { $group: { _id: '$agentId', spent: { $sum: '$spentMicros' } } },
  ]);
  const spent = new Map(spend.map((s) => [s._id.toString(), s.spent]));
  return {
    items: agents.map((a) => ({
      id: a._id.toString(),
      name: a.name,
      description: a.description ?? null,
      isActive: a.isActive,
      voice: a.voice,
      languageMode: a.languageMode,
      language: a.language,
      knowledgeBases: a.knowledge.knowledgeBaseIds.length,
      functions: a.functions.length,
      monthSpendMicros: spent.get(a._id.toString()) ?? 0,
      updatedAt: iso(a.updatedAt),
    })),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

export const getAgent = async (req: Request, id: string) =>
  toAgentView(await findAgent(tenantFilter(req).accountId, id));

export const createAgent = async (
  req: Request,
  body: z.infer<typeof CreateAgentBody>,
  deps: AgentsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const auth = requireAuth(req);
  const template = body.templateKey ? findTemplate(deps.env, body.templateKey) : undefined;
  if (body.templateKey && !template) {
    throw new ValidationError([{ path: 'templateKey', message: 'Unknown template' }]);
  }
  if ((await AiAgentModel.countDocuments({ accountId })) >= AI_LIMITS.agentsPerAccount) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${AI_LIMITS.agentsPerAccount} agents.`,
    );
  }
  if (await nameTaken(accountId, body.name)) throw duplicateName();
  const userId = new Types.ObjectId(auth.userId);
  try {
    const doc = await AiAgentModel.create({
      accountId,
      name: body.name,
      ...(template ? template.values : {}),
      description: body.description ?? template?.values.description ?? null,
      templateKey: template?.key ?? null,
      model: { textModel: deps.env.OPENAI_TEXT_MODEL },
      createdBy: userId,
      updatedBy: userId,
    });
    const agent = doc.toObject({ transform: false });
    await auditRequest(req, 'agent.created', {
      target: { type: 'agent', id: agent._id.toString() },
      meta: { name: agent.name, templateKey: agent.templateKey },
    });
    notifyChanged(accountId, agent._id);
    return toAgentView(agent);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
};

type Patch = z.infer<typeof UpdateAgentBody>;

/** Applies a PATCH (nested objects merged one level, arrays replaced). */
const merge = (agent: AiAgentDoc, patch: Patch): AiAgentDoc => {
  const next: AiAgentDoc = { ...agent };
  for (const [key, value] of Object.entries(patch) as [keyof Patch, unknown][]) {
    const current = agent[key as keyof AiAgentDoc];
    if (key === 'knowledge' && value && typeof value === 'object') {
      const k = value as Patch['knowledge'] & object;
      next.knowledge = {
        ...agent.knowledge,
        ...k,
        knowledgeBaseIds: k.knowledgeBaseIds
          ? [...new Set(k.knowledgeBaseIds)].map((id) => new Types.ObjectId(id))
          : agent.knowledge.knowledgeBaseIds,
      };
    } else if (key === 'builtInTools' && value && typeof value === 'object') {
      next.builtInTools = { ...agent.builtInTools, ...value };
    } else if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object'
    ) {
      (next as unknown as Record<string, unknown>)[key] = { ...(current as object), ...value };
    } else {
      (next as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return next;
};

export const updateAgent = async (req: Request, id: string, patch: Patch, deps: AgentsDeps) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  const next = merge(agent, patch);
  await validateAgent(accountId, next, deps.env);
  if (patch.name && (await nameTaken(accountId, patch.name, agent._id))) throw duplicateName();
  const set: Record<string, unknown> = { updatedBy: new Types.ObjectId(requireAuth(req).userId) };
  for (const key of Object.keys(patch)) set[key] = next[key as keyof AiAgentDoc];
  try {
    const saved = await AiAgentModel.findOneAndUpdate(
      { _id: agent._id, accountId },
      { $set: set },
      {
        returnDocument: 'after',
        runValidators: true,
      },
    ).lean<AiAgentDoc>();
    if (!saved) throw new NotFoundError('Agent not found');
    await auditRequest(req, 'agent.updated', {
      target: { type: 'agent', id: agent._id.toString() },
      meta: { fields: Object.keys(patch).sort() },
    });
    notifyChanged(accountId, agent._id);
    return toAgentView(saved);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
};

export const deleteAgent = async (req: Request, id: string): Promise<void> => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  await AiAgentModel.updateOne({ _id: agent._id, accountId }, { $set: { deletedAt: new Date() } });
  await auditRequest(req, 'agent.deleted', {
    target: { type: 'agent', id: agent._id.toString() },
    meta: { name: agent.name },
  });
  notifyChanged(accountId, agent._id);
};

export const duplicateAgent = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const source = await findAgent(accountId, id);
  if ((await AiAgentModel.countDocuments({ accountId })) >= AI_LIMITS.agentsPerAccount) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An account can have at most ${AI_LIMITS.agentsPerAccount} agents.`,
    );
  }
  const base = `${source.name.slice(0, AI_LIMITS.nameMaxChars - 12)} (copy)`;
  let name = base;
  for (let n = 2; await nameTaken(accountId, name); n += 1) name = `${base.slice(0, -1)} ${n})`;
  const userId = new Types.ObjectId(requireAuth(req).userId);
  const { _id: _sourceId, createdAt: _c, updatedAt: _u, deletedAt: _d, ...rest } = source;
  const doc = await AiAgentModel.create({
    ...rest,
    name,
    isActive: false,
    functions: source.functions.map(({ _id: _f, ...f }) => f),
    createdBy: userId,
    updatedBy: userId,
  });
  const agent = doc.toObject({ transform: false });
  await auditRequest(req, 'agent.duplicated', {
    target: { type: 'agent', id: agent._id.toString() },
    meta: { sourceAgentId: source._id.toString(), name },
  });
  notifyChanged(accountId, agent._id);
  return toAgentView(agent);
};

export const setAgentActive = async (req: Request, id: string, active: boolean) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  const saved = await AiAgentModel.findOneAndUpdate(
    { _id: agent._id, accountId },
    { $set: { isActive: active, updatedBy: new Types.ObjectId(requireAuth(req).userId) } },
    { returnDocument: 'after' },
  ).lean<AiAgentDoc>();
  if (!saved) throw new NotFoundError('Agent not found');
  if (agent.isActive !== active) {
    await auditRequest(req, active ? 'agent.activated' : 'agent.deactivated', {
      target: { type: 'agent', id: agent._id.toString() },
    });
    notifyChanged(accountId, agent._id);
  }
  return toAgentView(saved);
};

const companyName = async (accountId: Types.ObjectId) =>
  (await AccountModel.findById(accountId).select({ name: 1 }).lean<{ name: string }>())?.name ?? '';

export const compilePreview = async (
  req: Request,
  id: string,
  body: z.infer<typeof CompilePreviewBody>,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  const variables = body.contactId
    ? (
        await contactVariables(
          accountId,
          new Types.ObjectId(body.contactId),
          agent.allowedVariables,
        )
      ).values
    : manualVariables(body.variables, agent.allowedVariables);
  const compiled = compileAgent(agent, {
    company: await companyName(accountId),
    variables,
    channel: body.channel,
    now: new Date(),
    timezone: await accountTimezone(accountId),
  });
  return {
    instructions: compiled.instructions,
    tools: compiled.tools.map((t) => ({ name: t.name, description: t.description })),
    openingLine: compiled.openingLine,
    closingLine: compiled.closingLine,
    variables,
    warnings: compiled.warnings,
  };
};

export const agentUsage = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  const { day, month } = usageKeys(new Date(), await accountTimezone(accountId));
  const [today, sum] = await Promise.all([
    AgentUsageModel.findOne({ agentId: agent._id, day }).lean<{
      spentMicros: number;
      turns: number;
    }>(),
    AgentUsageModel.aggregate<{ spent: number; turns: number; input: number; output: number }>([
      { $match: { accountId, agentId: agent._id, month } },
      {
        $group: {
          _id: null,
          spent: { $sum: '$spentMicros' },
          turns: { $sum: '$turns' },
          input: { $sum: '$inputTokens' },
          output: { $sum: '$outputTokens' },
        },
      },
    ]),
  ]);
  const m = sum[0];
  return {
    today: { day, spentMicros: today?.spentMicros ?? 0, turns: today?.turns ?? 0 },
    month: {
      month,
      spentMicros: m?.spent ?? 0,
      turns: m?.turns ?? 0,
      inputTokens: m?.input ?? 0,
      outputTokens: m?.output ?? 0,
    },
  };
};

export const agentCatalog = async (req: Request, deps: AgentsDeps) => ({
  provider: deps.provider.name,
  voices: [...AGENT_VOICES],
  languages: [...AGENT_LANGUAGES],
  toneTriggers: [...TONE_TRIGGERS],
  dispositions: [...DISPOSITIONS],
  builtInTools: [...BUILT_IN_TOOLS],
  textModels: [...deps.env.AI_TEXT_MODELS],
  defaultTextModel: deps.env.OPENAI_TEXT_MODEL,
  variables: await accountVariables(tenantFilter(req).accountId),
  limits: {
    functionsPerAgent: AI_LIMITS.functionsPerAgent,
    kbPerAgent: AI_LIMITS.kbPerAgent,
    personaMaxChars: AI_LIMITS.personaMaxChars,
    messageMaxChars: AI_LIMITS.messageMaxChars,
  },
});

export const listTemplates = (deps: AgentsDeps) =>
  agentTemplates(deps.env).map((t) => ({
    key: t.key,
    title: t.title,
    summary: t.summary,
    language: t.language,
  }));
