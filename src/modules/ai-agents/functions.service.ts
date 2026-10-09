import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { Env } from '../../config/env';
import { AI_LIMITS } from '../../config/limits';
import {
  executeFunction,
  isKnownToken,
  templateTokens,
  type HttpToolOptions,
  type TemplateContext,
} from '../../core/ai/http-tool';
import { urlBlockReason, type GuardPolicy } from '../../core/ai/ip-guard';
import { redactArgs, redactPreview } from '../../core/ai/redact';
import { seal, secretHint } from '../../core/ai/secret-box';
import { argumentsValidator } from '../../core/ai/tools';
import { notifyAccount } from '../../core/realtime/notify';
import { AccountModel } from '../../db/models/account.model';
import { AgentToolCallModel, TOOL_CALL_TTL_MS } from '../../db/models/agent-tool-call.model';
import {
  AiAgentModel,
  BUILT_IN_TOOLS,
  type AgentFunction,
  type AiAgentDoc,
  type FunctionHeader,
} from '../../db/models/ai-agent.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';

import type { CreateFunctionBody, TestFunctionBody, UpdateFunctionBody } from './agents.schema';
import { findAgent, toAgentView } from './agents.service';

export interface FunctionsDeps {
  env: Pick<Env, 'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL'>;
  secretKey: Buffer;
  /** Test hooks for the executor (resolver / dial / extra ports). */
  http?: Omit<HttpToolOptions, 'policy'> & { extraPorts?: number[] };
}

/** Outgoing-request policy from env (PHASE_5_PLAN §1c). */
export const functionPolicy = (deps: FunctionsDeps): GuardPolicy => {
  const production = deps.env.NODE_ENV === 'production';
  const appPort = Number(new URL(deps.env.APP_URL || 'http://localhost').port) || null;
  return {
    httpsOnly: production,
    allowPrivate: deps.env.AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS,
    // the dev mock API runs on the backend port
    extraPorts: production
      ? []
      : [5100, 3100, ...(appPort ? [appPort] : []), ...(deps.http?.extraPorts ?? [])],
  };
};

const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'content-type',
]);
const PLACEHOLDER = 'x';

type CreateInput = z.infer<typeof CreateFunctionBody>;
type UpdateInput = z.infer<typeof UpdateFunctionBody>;
type HeaderInput = CreateInput['headers'][number];

const findFunction = (agent: AiAgentDoc, fnId: string): AgentFunction => {
  const fn = agent.functions.find((f) => f._id.toString() === fnId);
  if (!fn) throw new NotFoundError('Function not found');
  return fn;
};

/** Checks one function as it will be stored (after merging a PATCH). */
const validateFunction = (
  fn: Omit<AgentFunction, '_id' | 'headers'> & { headers: HeaderInput[] },
  others: AgentFunction[],
  policy: GuardPolicy,
): void => {
  const details: ErrorDetail[] = [];
  if ((BUILT_IN_TOOLS as readonly string[]).includes(fn.name)) {
    details.push({ path: 'name', message: 'This name is used by a built-in tool' });
  }
  if (others.some((o) => o.name === fn.name)) {
    details.push({ path: 'name', message: 'Another function already has this name' });
  }
  const paramNames = new Set<string>();
  fn.parameters.forEach((p, i) => {
    if (paramNames.has(p.name))
      details.push({ path: `parameters.${i}.name`, message: 'Duplicate name' });
    paramNames.add(p.name);
  });

  const checkTokens = (path: string, text: string) => {
    for (const token of templateTokens(text)) {
      if (!isKnownToken(token)) {
        details.push({ path, message: `Unknown placeholder {{${token}}}` });
      } else if (token.startsWith('args.') && !paramNames.has(token.slice(5))) {
        details.push({ path, message: `{{${token}}} is not one of the parameters` });
      }
    }
  };

  checkTokens('url', fn.url);
  const origin = /^[a-z]+:\/\/[^/?#]*/i.exec(fn.url)?.[0] ?? '';
  if (origin.includes('{{')) {
    details.push({ path: 'url', message: 'Placeholders are not allowed in the address host' });
  }
  let url: URL | null = null;
  try {
    url = new URL(fn.url.replace(/\{\{[^}]*\}\}/g, PLACEHOLDER));
  } catch {
    details.push({ path: 'url', message: 'Enter a full http(s) address' });
  }

  const headerNames = new Set<string>();
  fn.headers.forEach((h, i) => {
    const lower = h.name.toLowerCase();
    if (RESERVED_HEADERS.has(lower)) {
      details.push({ path: `headers.${i}.name`, message: 'This header is set automatically' });
    }
    if (headerNames.has(lower))
      details.push({ path: `headers.${i}.name`, message: 'Duplicate header' });
    headerNames.add(lower);
    if (h.value !== null && /[\r\n\0]/.test(h.value)) {
      details.push({ path: `headers.${i}.value`, message: 'Line breaks are not allowed' });
    }
    if (!h.secret && h.value !== null) checkTokens(`headers.${i}.value`, h.value);
  });

  if (fn.bodyTemplate) {
    if (fn.method === 'GET') {
      details.push({ path: 'bodyTemplate', message: 'GET requests have no body' });
    } else {
      try {
        const parsed: unknown = JSON.parse(fn.bodyTemplate);
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        checkTokens('bodyTemplate', fn.bodyTemplate);
      } catch {
        details.push({ path: 'bodyTemplate', message: 'Must be a JSON object or array' });
      }
    }
  }
  if (details.length) throw new ValidationError(details);

  const reason = url ? urlBlockReason(url, policy) : null;
  if (reason) {
    const message =
      reason === 'scheme'
        ? policy.httpsOnly
          ? 'Only https addresses are allowed'
          : 'Use an http or https address'
        : reason === 'port'
          ? 'Only ports 80, 443 and 8000–8999 are allowed'
          : reason === 'invalid'
            ? 'Addresses with a user name or password are not allowed'
            : 'Private, local and cloud-metadata addresses are not allowed';
    throw new AppError('FUNCTION_URL_BLOCKED', undefined, [{ path: 'url', message }]);
  }
};

/**
 * Input headers → stored headers. Secret values are sealed; a secret header
 * sent with `value: null` keeps the stored one (same name).
 */
const storeHeaders = (
  input: HeaderInput[],
  existing: FunctionHeader[],
  key: Buffer,
): FunctionHeader[] =>
  input.map((h, i) => {
    if (h.secret) {
      if (h.value === null || h.value === '') {
        const kept = existing.find(
          (e) => e.secret && e.name.toLowerCase() === h.name.toLowerCase() && e.sealed,
        );
        if (!kept)
          throw new ValidationError([{ path: `headers.${i}.value`, message: 'Enter a value' }]);
        return {
          name: h.name,
          secret: true,
          value: null,
          sealed: kept.sealed,
          valueHint: kept.valueHint,
        };
      }
      return {
        name: h.name,
        secret: true,
        value: null,
        sealed: seal(key, h.value),
        valueHint: secretHint(h.value),
      };
    }
    if (h.value === null)
      throw new ValidationError([{ path: `headers.${i}.value`, message: 'Enter a value' }]);
    return { name: h.name, secret: false, value: h.value, sealed: null, valueHint: null };
  });

/** Headers as the validator sees them (stored secrets count as present). */
const headersForCheck = (headers: FunctionHeader[]): HeaderInput[] =>
  headers.map((h) => ({
    name: h.name,
    secret: h.secret,
    value: h.secret ? null : (h.value ?? ''),
  }));

const changed = async (
  req: Request,
  agent: AiAgentDoc,
  fields: string[],
  change: 'function_added' | 'function_updated' | 'function_removed',
) => {
  await auditRequest(req, 'agent.updated', {
    target: { type: 'agent', id: agent._id.toString() },
    meta: { fields, change },
  });
  notifyAccount(agent.accountId.toString(), 'agent.updated', { agentId: agent._id.toString() });
};

const raced = () =>
  new ConflictError('CONFLICT_INVALID_STATE', 'The agent changed meanwhile. Reload and try again.');

const reload = async (agent: AiAgentDoc) =>
  toAgentView(await findAgent(agent.accountId, agent._id.toString()));

export const createFunction = async (
  req: Request,
  id: string,
  body: CreateInput,
  deps: FunctionsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  if (agent.functions.length >= AI_LIMITS.functionsPerAgent) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `An agent can have at most ${AI_LIMITS.functionsPerAgent} functions.`,
    );
  }
  const fn = {
    name: body.name,
    description: body.description,
    parameters: body.parameters,
    method: body.method,
    url: body.url,
    headers: body.headers,
    bodyTemplate: body.bodyTemplate ?? null,
    resultPath: body.resultPath ?? null,
    responseHint: body.responseHint ?? null,
    timeoutMs: body.timeoutMs,
  };
  validateFunction(fn, agent.functions, functionPolicy(deps));
  const stored = { ...fn, headers: storeHeaders(fn.headers, [], deps.secretKey) };
  const res = await AiAgentModel.updateOne(
    {
      _id: agent._id,
      accountId,
      [`functions.${AI_LIMITS.functionsPerAgent - 1}`]: { $exists: false },
      'functions.name': { $ne: fn.name },
    },
    {
      $push: { functions: stored },
      $set: { updatedBy: new Types.ObjectId(requireAuth(req).userId) },
    },
    { runValidators: true },
  );
  if (!res.modifiedCount) throw raced();
  await changed(req, agent, [`functions.${fn.name}`], 'function_added');
  return reload(agent);
};

export const updateFunction = async (
  req: Request,
  id: string,
  fnId: string,
  patch: UpdateInput,
  deps: FunctionsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  const current = findFunction(agent, fnId);
  const merged = {
    name: patch.name ?? current.name,
    description: patch.description ?? current.description,
    parameters: patch.parameters ?? current.parameters,
    method: patch.method ?? current.method,
    url: patch.url ?? current.url,
    headers: patch.headers ?? headersForCheck(current.headers),
    bodyTemplate:
      patch.bodyTemplate === undefined ? (current.bodyTemplate ?? null) : patch.bodyTemplate,
    resultPath: patch.resultPath === undefined ? (current.resultPath ?? null) : patch.resultPath,
    responseHint:
      patch.responseHint === undefined ? (current.responseHint ?? null) : patch.responseHint,
    timeoutMs: patch.timeoutMs ?? current.timeoutMs,
  };
  validateFunction(
    merged,
    agent.functions.filter((f) => !f._id.equals(current._id)),
    functionPolicy(deps),
  );
  const headers = patch.headers
    ? storeHeaders(patch.headers, current.headers, deps.secretKey)
    : current.headers;
  const res = await AiAgentModel.updateOne(
    {
      _id: agent._id,
      accountId,
      functions: { $not: { $elemMatch: { name: merged.name, _id: { $ne: current._id } } } },
    },
    {
      $set: {
        'functions.$[f]': { ...merged, _id: current._id, headers },
        updatedBy: new Types.ObjectId(requireAuth(req).userId),
      },
    },
    { arrayFilters: [{ 'f._id': current._id }], runValidators: true },
  );
  if (!res.modifiedCount && !res.matchedCount) throw raced();
  await changed(
    req,
    agent,
    Object.keys(patch)
      .sort()
      .map((field) => `functions.${current.name}.${field}`),
    'function_updated',
  );
  return reload(agent);
};

export const deleteFunction = async (req: Request, id: string, fnId: string) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  const fn = findFunction(agent, fnId);
  await AiAgentModel.updateOne(
    { _id: agent._id, accountId },
    {
      $pull: { functions: { _id: fn._id } },
      $set: { updatedBy: new Types.ObjectId(requireAuth(req).userId) },
    },
  );
  await changed(req, agent, [`functions.${fn.name}`], 'function_removed');
  return reload(agent);
};

type ContactFields = Pick<ContactDoc, 'phoneE164' | 'name' | 'externalId' | 'variables'>;

/** `{{contact.x}}` values: full phone / external id — server-side only, never to the model. */
export const contactTemplateValues = (contact: ContactFields | null): Record<string, unknown> =>
  contact
    ? {
        ...((contact.variables ?? {}) as unknown as Record<string, unknown>),
        phone: contact.phoneE164,
        name: contact.name ?? '',
        externalId: contact.externalId ?? '',
      }
    : {};

/** Logs one execution (no headers, redacted args and preview). */
export const logToolCall = (entry: {
  accountId: Types.ObjectId;
  agentId: Types.ObjectId;
  sessionId?: Types.ObjectId | null;
  source: 'playground' | 'test' | 'call';
  tool: string;
  kind: 'custom' | 'built_in';
  args: Record<string, unknown>;
  ok: boolean;
  httpStatus?: number | null;
  durationMs: number;
  resultBytes: number;
  resultText: string;
  errorCode?: string | null;
  now?: Date;
}) =>
  AgentToolCallModel.create({
    accountId: entry.accountId,
    agentId: entry.agentId,
    sessionId: entry.sessionId ?? null,
    source: entry.source,
    tool: entry.tool,
    kind: entry.kind,
    argsRedacted: redactArgs(entry.args),
    status: entry.ok ? 'ok' : 'error',
    httpStatus: entry.httpStatus ?? null,
    durationMs: entry.durationMs,
    resultBytes: entry.resultBytes,
    resultPreview: entry.resultText ? redactPreview(entry.resultText) : null,
    errorCode: entry.errorCode ?? null,
    expiresAt: new Date((entry.now ?? new Date()).getTime() + TOOL_CALL_TTL_MS),
  });

export const testFunction = async (
  req: Request,
  id: string,
  fnId: string,
  body: z.infer<typeof TestFunctionBody>,
  deps: FunctionsDeps,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, id);
  const fn = findFunction(agent, fnId);

  let contact: ContactFields | null = null;
  if (body.contactId) {
    const _id = toObjectId(body.contactId);
    contact = _id
      ? await ContactModel.findOne({ _id, accountId })
          .select({ phoneE164: 1, name: 1, externalId: 1, variables: 1 })
          .lean<ContactFields>()
      : null;
    if (!contact) throw new NotFoundError('Contact not found');
  } else if (body.testPhone) {
    contact = {
      phoneE164: body.testPhone,
      name: null,
      externalId: null,
      variables: {},
    } as ContactFields;
  }

  const parsed = argumentsValidator(fn.parameters).safeParse(body.args);
  if (!parsed.success) {
    const result = {
      ok: false,
      httpStatus: null,
      durationMs: 0,
      result: '',
      warnings: [] as string[],
      error: 'invalid_arguments',
      details: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
    await logToolCall({
      accountId,
      agentId: agent._id,
      source: 'test',
      tool: fn.name,
      kind: 'custom',
      args: body.args,
      ok: false,
      durationMs: 0,
      resultBytes: 0,
      resultText: '',
      errorCode: 'invalid_arguments',
    });
    return result;
  }

  const account = await AccountModel.findById(accountId)
    .select({ name: 1 })
    .lean<{ name: string }>();
  const ctx: TemplateContext = {
    args: parsed.data,
    contact: contactTemplateValues(contact),
    agentName: agent.name,
    company: account?.name ?? '',
  };
  const out = await executeFunction(fn, ctx, deps.secretKey, {
    ...deps.http,
    policy: functionPolicy(deps),
  });
  await logToolCall({
    accountId,
    agentId: agent._id,
    source: 'test',
    tool: fn.name,
    kind: 'custom',
    args: parsed.data,
    ok: out.ok,
    httpStatus: out.httpStatus,
    durationMs: out.durationMs,
    resultBytes: out.bytes,
    resultText: out.resultText,
    errorCode: out.error ?? null,
  });
  return {
    ok: out.ok,
    httpStatus: out.httpStatus,
    durationMs: out.durationMs,
    result: out.resultText,
    warnings: out.warnings,
    error: out.error ?? null,
  };
};
