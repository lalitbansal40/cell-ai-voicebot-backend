import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { Env } from '../../config/env';
import { AI_LIMITS } from '../../config/limits';
import { compileAgent } from '../../core/ai/compile';
import type { HttpToolOptions } from '../../core/ai/http-tool';
import { outgoingPolicy } from '../../core/ai/ip-guard';
import { runAgentTurn, type TurnRecord } from '../../core/ai/run-turn';
import type { AiProvider } from '../../core/ai/types';
import { AccountModel } from '../../db/models/account.model';
import {
  AgentPlaygroundSessionModel,
  PLAYGROUND_TTL_MS,
  type AgentPlaygroundSessionDoc,
  type PlaygroundOutcome,
  type PlaygroundTurn,
} from '../../db/models/agent-playground-session.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { accountTimezone } from '../wallet/wallet.service';

import { findAgent } from './agents.service';
import { contactTemplateValues } from './functions.service';
import type { CreateSessionBody, ListSessionsQuery, SendMessageBody } from './playground.schema';
import { contactVariables, manualVariables } from './variables';

export interface PlaygroundDeps {
  env: Pick<
    Env,
    'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL' | 'OPENAI_EMBEDDING_MODEL'
  >;
  provider: AiProvider;
  secretKey: Buffer;
  http?: Omit<HttpToolOptions, 'policy'> & { extraPorts?: number[] };
  /** Tests: fixed clock. */
  now?: () => Date;
}

const iso = (d: Date) => d.toISOString();

const toTurnView = (t: PlaygroundTurn) => ({
  id: t._id.toString(),
  clientTurnId: t.clientTurnId ?? null,
  role: t.role,
  text: t.text,
  toolCalls: t.toolCalls.map((c) => ({
    name: c.name,
    kind: c.kind,
    // MongoDB drops empty objects — a tool call without arguments still answers {}
    args: c.args ?? {},
    ok: c.ok,
    simulated: c.simulated,
    durationMs: c.durationMs,
    resultPreview: c.resultPreview ?? null,
    error: c.error ?? null,
  })),
  knowledge: t.knowledge.map((k) => ({ title: k.title, snippet: k.snippet, score: k.score })),
  inputTokens: t.inputTokens,
  outputTokens: t.outputTokens,
  costMicros: t.costMicros,
  billing: t.billing,
  guardrail: t.guardrail ?? null,
  fallback: (t.fallback ?? null) as 'aiFailed' | 'walletEmpty' | 'agentOff' | 'capReached' | null,
  at: iso(t.at),
});

const toOutcomeView = (o: PlaygroundOutcome) => ({
  disposition: o.disposition ?? null,
  promiseToPay: o.promiseToPay ?? null,
  callback: o.callback ?? null,
  transferRequested: o.transferRequested,
  endRequested: o.endRequested,
  smsTemplate: o.smsTemplate ?? null,
});

/** Session JSON — never the test phone or a full contact phone. */
export const toSessionView = (s: AgentPlaygroundSessionDoc & { testPhone?: string | null }) => ({
  id: s._id.toString(),
  agentId: s.agentId.toString(),
  userId: s.userId.toString(),
  contactId: s.contactId?.toString() ?? null,
  variables: s.variables ?? {},
  hasTestPhone: Boolean(s.testPhone),
  turns: s.turns.map(toTurnView),
  outcome: toOutcomeView(s.outcome),
  status: s.status,
  costMicros: s.turns.reduce((sum, t) => sum + t.costMicros, 0),
  expiresAt: iso(s.expiresAt),
  createdAt: iso(s.createdAt),
});

const findSession = async (
  accountId: Types.ObjectId,
  agentId: Types.ObjectId,
  sid: string,
  withPhone = false,
): Promise<AgentPlaygroundSessionDoc> => {
  const _id = toObjectId(sid);
  const query = _id ? AgentPlaygroundSessionModel.findOne({ _id, accountId, agentId }) : null;
  const session = query
    ? await (withPhone ? query.select('+testPhone') : query).lean<AgentPlaygroundSessionDoc>()
    : null;
  if (!session) throw new NotFoundError('Conversation not found');
  return session;
};

const companyName = async (accountId: Types.ObjectId) =>
  (await AccountModel.findById(accountId).select({ name: 1 }).lean<{ name: string }>())?.name ?? '';

/** Creates a session with the opening line as its first turn (no model call, no cost). */
const openSession = async (
  accountId: Types.ObjectId,
  agentId: Types.ObjectId,
  userId: Types.ObjectId,
  values: {
    contactId: Types.ObjectId | null;
    variables: Record<string, string>;
    testPhone: string | null;
  },
  deps: PlaygroundDeps,
) => {
  const agent = await findAgent(accountId, agentId.toString());
  const now = deps.now?.() ?? new Date();
  const compiled = compileAgent(agent, {
    company: await companyName(accountId),
    variables: values.variables,
    channel: 'text',
    now,
    timezone: await accountTimezone(accountId),
  });
  const opening = compiled.openingLine.trim();
  const doc = await AgentPlaygroundSessionModel.create({
    accountId,
    agentId,
    userId,
    contactId: values.contactId,
    variables: values.variables,
    testPhone: values.testPhone,
    turns: opening ? [{ role: 'assistant', text: opening, at: now }] : [],
    expiresAt: new Date(now.getTime() + PLAYGROUND_TTL_MS),
  });
  return toSessionView(doc.toObject({ transform: false }));
};

export const createSession = async (
  req: Request,
  agentId: string,
  body: z.infer<typeof CreateSessionBody>,
  deps: PlaygroundDeps,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, agentId);
  let variables: Record<string, string>;
  let contactId: Types.ObjectId | null = null;
  if (body.contactId) {
    contactId = new Types.ObjectId(body.contactId);
    variables = (await contactVariables(accountId, contactId, agent.allowedVariables)).values;
  } else {
    variables = manualVariables(body.variables, agent.allowedVariables);
    // a test phone shows only its last 4 digits, and only when that variable is allowed
    if (body.testPhone && agent.allowedVariables.includes('phone_last4')) {
      variables.phone_last4 = body.testPhone.slice(-4);
    }
  }
  return openSession(
    accountId,
    agent._id,
    new Types.ObjectId(requireAuth(req).userId),
    { contactId, variables, testPhone: body.testPhone ?? null },
    deps,
  );
};

export const listSessions = async (
  req: Request,
  agentId: string,
  query: z.infer<typeof ListSessionsQuery>,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, agentId);
  const sessions = await AgentPlaygroundSessionModel.find({
    accountId,
    agentId: agent._id,
    ...(query.mine ? { userId: new Types.ObjectId(requireAuth(req).userId) } : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(20)
    .lean<AgentPlaygroundSessionDoc[]>();
  return sessions.map((s) => ({
    id: s._id.toString(),
    userId: s.userId.toString(),
    status: s.status,
    turns: s.turns.length,
    costMicros: s.turns.reduce((sum, t) => sum + t.costMicros, 0),
    lastText: s.turns.at(-1)?.text.slice(0, 120) ?? null,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  }));
};

export const getSession = async (req: Request, agentId: string, sid: string) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, agentId);
  return toSessionView(await findSession(accountId, agent._id, sid, true));
};

const ended = () =>
  new ConflictError('CONFLICT_INVALID_STATE', 'This conversation has ended. Start a new one.');

const replyOf = (session: AgentPlaygroundSessionDoc, clientTurnId: string) => {
  const user = session.turns.find((t) => t.role === 'user' && t.clientTurnId === clientTurnId);
  const reply = session.turns.find(
    (t) => t.role === 'assistant' && t.clientTurnId === clientTurnId,
  );
  return user && reply ? { user, reply } : null;
};

export const sendMessage = async (
  req: Request,
  agentId: string,
  sid: string,
  body: z.infer<typeof SendMessageBody>,
  deps: PlaygroundDeps,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, agentId);
  const session = await findSession(accountId, agent._id, sid, true);
  const done = replyOf(session, body.clientTurnId);
  if (done) {
    return {
      userTurn: toTurnView(done.user),
      turn: toTurnView(done.reply),
      outcome: toOutcomeView(session.outcome),
      status: session.status,
      replay: true,
    };
  }
  if (session.status === 'ended') throw ended();
  const now = deps.now?.() ?? new Date();

  // claim the clientTurnId: only one request can add this user turn
  const userTurn = {
    _id: new Types.ObjectId(),
    clientTurnId: body.clientTurnId,
    role: 'user' as const,
    text: body.text,
    at: now,
  };
  const claimed = await AgentPlaygroundSessionModel.updateOne(
    {
      _id: session._id,
      accountId,
      status: 'active',
      [`turns.${AI_LIMITS.turnsPerSession - 2}`]: { $exists: false },
      turns: { $not: { $elemMatch: { role: 'user', clientTurnId: body.clientTurnId } } },
    },
    { $push: { turns: userTurn } },
  );
  if (!claimed.modifiedCount) {
    const fresh = await findSession(accountId, agent._id, sid);
    if (fresh.turns.length >= AI_LIMITS.turnsPerSession - 1) {
      await AgentPlaygroundSessionModel.updateOne(
        { _id: session._id, accountId },
        { $set: { status: 'ended' } },
      );
      throw new ConflictError(
        'CONFLICT_INVALID_STATE',
        'This conversation is too long. Start a new one.',
      );
    }
    if (fresh.status === 'ended') throw ended();
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This message is still being answered.');
  }

  let contact: Record<string, unknown> = {};
  if (session.contactId) {
    const found = await ContactModel.findOne({ _id: session.contactId, accountId })
      .select({ phoneE164: 1, name: 1, externalId: 1, variables: 1 })
      .lean<Pick<ContactDoc, 'phoneE164' | 'name' | 'externalId' | 'variables'>>();
    contact = contactTemplateValues(found);
  } else if (session.testPhone) {
    contact = { phone: session.testPhone };
  }

  let result: Awaited<ReturnType<typeof runAgentTurn>>;
  try {
    result = await runAgentTurn({
      accountId,
      agent,
      session: { _id: session._id, turns: session.turns, variables: session.variables },
      userText: body.text,
      clientTurnId: body.clientTurnId,
      provider: deps.provider,
      now,
      timezone: await accountTimezone(accountId),
      company: await companyName(accountId),
      contact,
      secretKey: deps.secretKey,
      http: { ...deps.http, policy: outgoingPolicy(deps.env, deps.http?.extraPorts) },
      embeddingModel: deps.env.OPENAI_EMBEDDING_MODEL,
      source: 'playground',
    });
  } catch (err) {
    // nothing answered (e.g. spend cap set to stop): the user turn is withdrawn
    await AgentPlaygroundSessionModel.updateOne(
      { _id: session._id, accountId },
      { $pull: { turns: { _id: userTurn._id } } },
    );
    throw err;
  }

  const assistant: TurnRecord & { _id: Types.ObjectId } = {
    ...result.turn,
    _id: new Types.ObjectId(),
  };
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result.outcome)) set[`outcome.${key}`] = value;
  if (result.ended) set.status = 'ended';
  const saved = await AgentPlaygroundSessionModel.findOneAndUpdate(
    { _id: session._id, accountId },
    { $push: { turns: assistant }, ...(Object.keys(set).length ? { $set: set } : {}) },
    { returnDocument: 'after' },
  ).lean<AgentPlaygroundSessionDoc>();
  if (!saved) throw new NotFoundError('Conversation not found');
  const stored = replyOf(saved, body.clientTurnId);
  return {
    userTurn: toTurnView(stored?.user ?? (userTurn as unknown as PlaygroundTurn)),
    turn: toTurnView(stored?.reply ?? assistant),
    outcome: toOutcomeView(saved.outcome),
    status: saved.status,
    replay: false,
  };
};

export const resetSession = async (
  req: Request,
  agentId: string,
  sid: string,
  deps: PlaygroundDeps,
) => {
  const { accountId } = tenantFilter(req);
  const agent = await findAgent(accountId, agentId);
  const session = await findSession(accountId, agent._id, sid, true);
  await AgentPlaygroundSessionModel.updateOne(
    { _id: session._id, accountId },
    { $set: { status: 'ended' } },
  );
  let variables = session.variables;
  if (session.contactId) {
    variables = (await contactVariables(accountId, session.contactId, agent.allowedVariables))
      .values;
  }
  return openSession(
    accountId,
    agent._id,
    new Types.ObjectId(requireAuth(req).userId),
    { contactId: session.contactId, variables, testPhone: session.testPhone ?? null },
    deps,
  );
};
