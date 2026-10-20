import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { CALL_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { AiAgentModel, type AiAgentDoc } from '../../db/models/ai-agent.model';
import { CallEventModel } from '../../db/models/call-event.model';
import { CallModel, type CallDoc, type CallSource } from '../../db/models/call.model';
import { CampaignModel } from '../../db/models/campaign.model';
import { ContactModel } from '../../db/models/contact.model';
import { FlowModel } from '../../db/models/flow.model';
import { TranscriptTurnModel } from '../../db/models/transcript-turn.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor';
import { contactVariables, manualVariables } from '../ai-agents/variables';
import { auditRequest } from '../audit/audit.service';
import { findFlow, type FlowsDeps } from '../flows/flows.service';
import { resolveStartValues, resolveVersion } from '../flows/run-values';

import type { CallManager } from './call.service';
import type { ListCallsQuery, StartWebCallBody } from './calls.schema';
import type { CallRegistry } from './registry';

export interface CallsDeps extends FlowsDeps {
  manager: CallManager;
  registry: CallRegistry;
  storage?: StorageProvider | undefined;
  /** `call.say_text` allowed (dev / tests). */
  textInput: boolean;
  /** Which voice runs the calls (the tester shows a badge for the fake one). */
  voiceProvider: 'openai' | 'fake';
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type Names = {
  users: Map<string, string>;
  contacts: Map<string, string>;
  flows: Map<string, string>;
  agents: Map<string, string>;
  campaigns: Map<string, string>;
};

/** Names for the views (users, contacts, flows, agents) in one query each. */
const namesOf = async (accountId: Types.ObjectId, calls: CallDoc[]): Promise<Names> => {
  const ids = (pick: (c: CallDoc) => Types.ObjectId | null | undefined) => [
    ...new Set(calls.map(pick).filter(Boolean).map(String)),
  ];
  const userIds = ids((c) => c.startedBy);
  const contactIds = ids((c) => c.contactId);
  const flowIds = ids((c) => c.source.flowId);
  const agentIds = ids((c) => c.source.agentId);
  const campaignIds = ids((c) => c.campaignId);
  const map = (rows: { _id: Types.ObjectId; name?: string | null }[]) =>
    new Map(rows.map((r) => [r._id.toString(), r.name ?? '']));
  const [users, contacts, flows, agents, campaigns] = await Promise.all([
    userIds.length
      ? UserModel.find({ _id: { $in: userIds } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : [],
    contactIds.length
      ? ContactModel.find({ accountId, _id: { $in: contactIds } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string | null }[]>()
      : [],
    flowIds.length
      ? FlowModel.find({ accountId, _id: { $in: flowIds } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : [],
    agentIds.length
      ? AiAgentModel.find({ accountId, _id: { $in: agentIds } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : [],
    campaignIds.length
      ? CampaignModel.find({ accountId, _id: { $in: campaignIds } }, null, { withDeleted: true })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : [],
  ]);
  return {
    users: map(users),
    contacts: map(contacts),
    flows: map(flows),
    agents: map(agents),
    campaigns: map(campaigns),
  };
};

/** Public view of a call — never the test phone, hold, recording key or raw numbers. */
export const toCallView = (c: CallDoc, names: Names) => {
  const flowId = c.source.flowId?.toString() ?? null;
  const agentId = c.source.agentId?.toString() ?? null;
  const contactId = c.contactId?.toString() ?? null;
  const userId = c.startedBy?.toString() ?? null;
  return {
    id: c._id.toString(),
    direction: c.direction,
    provider: c.provider,
    isTest: c.isTest,
    /** Dry-run calls are priced but never charged. */
    charged: c.charged,
    campaign: c.campaignId
      ? {
          id: c.campaignId.toString(),
          name: names.campaigns.get(c.campaignId.toString()) ?? '',
          attempt: c.attempt ?? 1,
        }
      : null,
    status: c.status,
    endReason: c.endReason,
    source: {
      kind: c.source.kind,
      flowId,
      flowVersionRef: c.source.flowVersionRef ?? null,
      agentId,
      name: (flowId ? names.flows.get(flowId) : agentId ? names.agents.get(agentId) : null) ?? null,
    },
    contact: contactId ? { id: contactId, name: names.contacts.get(contactId) ?? '' } : null,
    startedBy: userId ? { id: userId, name: names.users.get(userId) ?? '' } : null,
    timestamps: {
      queuedAt: c.timestamps.queuedAt.toISOString(),
      ringingAt: iso(c.timestamps.ringingAt),
      answeredAt: iso(c.timestamps.answeredAt),
      endedAt: iso(c.timestamps.endedAt),
    },
    durationSec: c.durationSec,
    variables: { ...c.variables },
    outcome: { ...c.outcome },
    disposition: c.disposition,
    languageDetected: c.languageDetected,
    metrics: {
      latency: { ...c.metrics.latency },
      bargeIns: c.metrics.bargeIns,
      silencePrompts: c.metrics.silencePrompts,
      aiSeconds: c.metrics.aiSeconds,
      ttsChars: c.metrics.ttsChars,
      ttsCachedChars: c.metrics.ttsCachedChars,
    },
    cost: { ...c.cost },
    recording: c.recording
      ? { durationSec: c.recording.durationSec, sizeBytes: c.recording.sizeBytes }
      : null,
    flowRunId: c.flowRunId?.toString() ?? null,
    error: c.error ? { code: c.error.code } : null,
    createdAt: c.createdAt.toISOString(),
  };
};

export const viewOne = async (c: CallDoc) => toCallView(c, await namesOf(c.accountId, [c]));

export const findCall = async (accountId: Types.ObjectId, id: string): Promise<CallDoc> => {
  const call = await CallModel.findOne({ _id: id, accountId }).lean<CallDoc>();
  if (!call) throw new NotFoundError('Call not found');
  return call;
};

const need = (req: Request, permission: string) => {
  if (!requireAuth(req).permissions.has(permission)) throw new ForbiddenError();
};

/** `POST /calls/web`: validations → call (queued) + wallet hold + media ticket. */
export const startWebCall = async (
  req: Request,
  body: z.infer<typeof StartWebCallBody>,
  deps: CallsDeps,
) => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  const contactId = body.contactId ? new Types.ObjectId(body.contactId) : null;
  let source: CallSource;
  let variables: Record<string, string>;
  if (body.flowId) {
    need(req, 'flows.read');
    const flow = await findFlow(accountId, body.flowId);
    const { graph, versionRef } = await resolveVersion(flow, body.version ?? 'published', deps);
    const { contact } = await resolveStartValues(accountId, graph, {
      contactId,
      variables: body.variables,
      testPhone: body.testPhone,
    });
    source = { kind: 'flow', flowId: flow._id, flowVersionRef: versionRef };
    variables = contact.display;
  } else {
    need(req, 'agents.read');
    const agent = await AiAgentModel.findOne({ _id: body.agentId, accountId }).lean<AiAgentDoc>();
    if (!agent) throw new NotFoundError('Agent not found');
    if (!agent.isActive) {
      throw new ValidationError([{ path: 'agentId', message: 'This agent is switched off' }]);
    }
    const unknown = Object.keys(body.variables ?? {}).filter(
      (name) => !agent.allowedVariables.includes(name),
    );
    if (unknown.length) {
      throw new ValidationError(
        unknown.map((name) => ({
          path: `variables.${name}`,
          message: 'Not a variable this agent may see',
        })),
      );
    }
    source = { kind: 'agent', agentId: agent._id };
    variables = contactId
      ? (await contactVariables(accountId, contactId, agent.allowedVariables)).values
      : manualVariables(body.variables, agent.allowedVariables);
  }
  const started = await deps.manager.createWebCall({
    accountId: accountId.toString(),
    userId: auth.userId ?? '',
    source,
    contactId: contactId?.toString() ?? null,
    variables,
    manualVariables: contactId ? null : (body.variables ?? null),
    testPhone: contactId ? null : (body.testPhone ?? null),
  });
  await auditRequest(req, 'call.test_started', {
    target: { type: 'call', id: started.callId },
    meta: {
      source: source.kind,
      ...(source.flowId
        ? { flowId: source.flowId.toString(), version: source.flowVersionRef }
        : {}),
      ...(source.agentId ? { agentId: source.agentId.toString() } : {}),
    },
  });
  const call = await findCall(accountId, started.callId);
  return {
    call: await viewOne(call),
    mediaTicket: started.mediaTicket,
    expiresAt: started.expiresAt,
    wsPath: started.wsPath,
    textInput: deps.textInput,
    voice: deps.voiceProvider,
  };
};

export const listCalls = async (req: Request, query: z.infer<typeof ListCallsQuery>) => {
  const { accountId } = tenantFilter(req);
  const filter: Record<string, unknown> = { accountId };
  if (query.status) filter.status = { $in: query.status };
  if (query.flowId) filter['source.flowId'] = new Types.ObjectId(query.flowId);
  if (query.agentId) filter['source.agentId'] = new Types.ObjectId(query.agentId);
  if (query.isTest !== undefined) filter.isTest = query.isTest;
  if (query.campaignId) filter.campaignId = new Types.ObjectId(query.campaignId);
  if (query.provider) filter.provider = query.provider;
  const at: Record<string, Date> = {};
  if (query.from) at.$gte = new Date(query.from);
  if (query.to) at.$lt = new Date(query.to);
  if (Object.keys(at).length) filter.createdAt = at;
  if (query.contactId) filter.contactId = new Types.ObjectId(query.contactId);
  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = await ContactModel.find({ accountId, name: { $regex: escaped, $options: 'i' } })
      .select({ _id: 1 })
      .limit(500)
      .lean<{ _id: Types.ObjectId }[]>();
    const ids = found
      .map((c) => c._id)
      .filter((id) => !query.contactId || id.toString() === query.contactId);
    filter.contactId = { $in: ids };
  }
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    const cAt = new Date(c.at);
    filter.$or = [
      { createdAt: { $lt: cAt } },
      { createdAt: cAt, _id: { $lt: new Types.ObjectId(c.id) } },
    ];
  }
  const rows = await CallModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean<CallDoc[]>();
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const names = await namesOf(accountId, page);
  const last = page.at(-1);
  return {
    items: page.map((c) => toCallView(c, names)),
    meta: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last._id.toString() })
          : null,
    },
  };
};

export const activeCalls = async (req: Request, deps: Pick<CallsDeps, 'registry'>) => {
  const { accountId } = tenantFilter(req);
  const ids = await deps.registry.liveCalls(accountId.toString());
  if (!ids.length) return [];
  const rows = await CallModel.find({ accountId, _id: { $in: ids } })
    .sort({ createdAt: -1 })
    .lean<CallDoc[]>();
  const names = await namesOf(accountId, rows);
  return rows.map((c) => toCallView(c, names));
};

export const getCall = async (req: Request, id: string) =>
  viewOne(await findCall(tenantFilter(req).accountId, id));

export const callTranscript = async (req: Request, id: string) => {
  const call = await findCall(tenantFilter(req).accountId, id);
  const turns = await TranscriptTurnModel.find({ callId: call._id, accountId: call.accountId })
    .sort({ seq: 1 })
    .limit(CALL_LIMITS.transcriptListedMax)
    .lean();
  return turns.map((t) => ({
    seq: t.seq,
    speaker: t.speaker,
    text: t.text,
    language: t.language ?? null,
    startMs: t.startMs,
    endMs: t.endMs,
    interrupted: t.interrupted,
    source: t.source,
  }));
};

export const callEvents = async (req: Request, id: string) => {
  const call = await findCall(tenantFilter(req).accountId, id);
  const events = await CallEventModel.find({ callId: call._id, accountId: call.accountId })
    .sort({ seq: 1 })
    .limit(CALL_LIMITS.eventsListedMax)
    .lean();
  return events.map((e) => ({ seq: e.seq, type: e.type, data: e.data, at: e.at.toISOString() }));
};

/** Signed link to the stereo recording (audited every time). */
export const recordingLink = async (req: Request, id: string, deps: Pick<CallsDeps, 'storage'>) => {
  const call = await findCall(tenantFilter(req).accountId, id);
  if (!call.recording || !deps.storage) throw new NotFoundError('This call has no recording');
  const ttl = CALL_LIMITS.recordingUrlTtlSec;
  const url = await deps.storage.signedUrl(call.recording.fileKey, { expiresInSec: ttl });
  await auditRequest(req, 'call.recording_accessed', { target: { type: 'call', id } });
  return {
    url,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    durationSec: call.recording.durationSec,
  };
};

/** Ends a live call of this process from another tab. */
export const hangupCall = async (req: Request, id: string, deps: Pick<CallsDeps, 'manager'>) => {
  const { accountId } = tenantFilter(req);
  await findCall(accountId, id);
  await deps.manager.hangup(accountId.toString(), id);
  await auditRequest(req, 'call.hung_up_remotely', { target: { type: 'call', id } });
  return viewOne(await findCall(accountId, id));
};
