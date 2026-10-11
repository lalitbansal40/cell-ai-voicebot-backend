import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { Env } from '../../config/env';
import { FLOW_LIMITS } from '../../config/limits';
import type { HttpToolOptions } from '../../core/ai/http-tool';
import { outgoingPolicy } from '../../core/ai/ip-guard';
import type { AiProvider } from '../../core/ai/types';
import { InputMismatchError, RunEndedError, advance, runValues } from '../../core/engine/engine';
import { FlowGraphSchema, type FlowGraph } from '../../core/engine/schema';
import { mongoStatsRecorder } from '../../core/engine/stats';
import type {
  AdvanceResult,
  FlowInput,
  FlowOutput,
  FlowRunState,
  TraceRow,
} from '../../core/engine/types';
import { hasErrors } from '../../core/engine/validate';
import { SYSTEM_VARIABLE_NAMES, coerce, type RunValue } from '../../core/engine/variables';
import { AccountModel } from '../../db/models/account.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { FlowNodeStatsModel } from '../../db/models/flow-node-stats.model';
import { FlowRunModel, SIMULATOR_TTL_MS, type FlowRunDoc } from '../../db/models/flow-run.model';
import { FlowVersionModel, type FlowVersionDoc } from '../../db/models/flow-version.model';
import type { FlowDoc } from '../../db/models/flow.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { addDays, ymdInZone } from '../../shared/time';
import { contactTemplateValues } from '../ai-agents/functions.service';
import { accountVariables, contactVariables } from '../ai-agents/variables';
import { accountTimezone } from '../wallet/wallet.service';

import { createFlowEffects } from './effects';
import { findFlow, flowInvalid, issuesOf, type FlowsDeps } from './flows.service';
import type {
  ListSimulationsQuery,
  SimulationInputBody,
  StartSimulationBody,
  StatsQuery,
} from './simulator.schema';

export interface SimulatorDeps extends FlowsDeps {
  env: FlowsDeps['env'] & Pick<Env, 'OPENAI_TEXT_MODEL' | 'OPENAI_EMBEDDING_MODEL'>;
  provider: AiProvider;
  /** Test hooks for API / function calls (fake resolver, dial map). */
  http?: Omit<HttpToolOptions, 'policy'>;
  now?: () => Date;
}

export interface TranscriptEntry {
  seq: number;
  role: 'bot' | 'customer' | 'system';
  kind: 'say' | 'play' | 'dtmf' | 'speech' | 'ai' | 'message' | 'transfer' | 'note';
  text: string;
  nodeId: string | null;
  at: string;
  meta?: Record<string, unknown>;
}

const iso = (d: Date) => d.toISOString();
const END_TEXT: Record<string, string> = {
  hangup_node: 'Call ended',
  transferred: 'Call transferred',
  customer_hangup: 'Customer hung up',
  max_duration: 'Call ended: maximum duration reached',
  loop_guard: 'Call ended: the flow looped without waiting',
  error_handler: 'Call ended by the flow error handler',
  engine_error: 'Call ended: engine error',
  inputs_exhausted: 'Call ended: too many inputs',
};

// ── Transcript ──────────────────────────────────────────────────────────────

const entriesForInput = (input: FlowInput): Omit<TranscriptEntry, 'seq' | 'at'>[] => {
  switch (input.kind) {
    case 'dtmf':
      return [{ role: 'customer', kind: 'dtmf', text: `Pressed ${input.digits}`, nodeId: null }];
    case 'speech':
      return [{ role: 'customer', kind: 'speech', text: input.text, nodeId: null }];
    case 'no_input':
      return [{ role: 'system', kind: 'note', text: '(silence)', nodeId: null }];
    case 'transfer_result':
      return [
        {
          role: 'system',
          kind: 'transfer',
          text: `Transfer ${input.result.replace('_', ' ')}`,
          nodeId: null,
        },
      ];
    case 'hangup':
      return [];
    default:
      return [];
  }
};

const entriesForOutput = (o: FlowOutput): Omit<TranscriptEntry, 'seq' | 'at'>[] => {
  switch (o.type) {
    case 'say':
      return [{ role: 'bot', kind: 'say', text: o.text, nodeId: o.nodeId }];
    case 'play':
      return [
        {
          role: 'bot',
          kind: 'play',
          text: o.audioName,
          nodeId: o.nodeId,
          meta: { audioId: o.audioId, name: o.audioName },
        },
      ];
    case 'ai_reply':
      return [
        {
          role: 'bot',
          kind: 'ai',
          text: o.text,
          nodeId: o.nodeId,
          meta: {
            toolCalls: o.toolCalls,
            knowledge: o.knowledge,
            costMicros: o.costMicros,
            fallback: o.fallback,
            guardrail: o.guardrail,
          },
        },
      ];
    case 'message_queued':
      return [
        {
          role: 'system',
          kind: 'message',
          text: o.preview,
          nodeId: o.nodeId,
          meta: { channel: o.channel },
        },
      ];
    case 'transfer':
      return [
        {
          role: 'system',
          kind: 'transfer',
          text: `Transferring to ••••${o.phone.slice(-4)}`,
          nodeId: o.nodeId,
        },
      ];
    case 'pause':
      return [
        {
          role: 'system',
          kind: 'note',
          text: `Waited ${String(o.seconds)} s (skipped in the simulator)`,
          nodeId: o.nodeId,
        },
      ];
    case 'note':
      return [{ role: 'system', kind: 'note', text: o.text, nodeId: o.nodeId }];
    case 'hangup':
      return [
        {
          role: 'system',
          kind: 'note',
          text: END_TEXT[o.reason] ?? 'Call ended',
          nodeId: o.nodeId,
          meta: { reason: o.reason },
        },
      ];
    default:
      return [];
  }
};

// ── Views ───────────────────────────────────────────────────────────────────

const userNames = async (ids: (Types.ObjectId | null)[]) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const users = unique.length
    ? await UserModel.find({ _id: { $in: unique } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  return new Map(users.map((u) => [u._id.toString(), u.name]));
};

const graphOfRun = async (
  run: Pick<FlowRunDoc, 'graph' | 'versionRef' | 'flowId'>,
): Promise<FlowGraph> => {
  if (run.versionRef === 'draft') return run.graph as unknown as FlowGraph;
  const version = await FlowVersionModel.findOne({ flowId: run.flowId, version: run.versionRef })
    .select({ graph: 1 })
    .lean<FlowVersionDoc>();
  if (!version) throw new NotFoundError('Version not found');
  return version.graph as unknown as FlowGraph;
};

const toRunView = async (run: FlowRunDoc, graph: FlowGraph, full: boolean) => {
  const state = run.state as unknown as FlowRunState;
  const users = await userNames([run.createdBy]);
  const values = runValues(graph, state);
  const o = state.outcome;
  return {
    id: run._id.toString(),
    flowId: run.flowId.toString(),
    versionRef: run.versionRef,
    status: run.status,
    waiting: run.waiting as never,
    currentNodeId: state.nodeId ?? null,
    variables: values,
    outcome: {
      disposition: o.disposition,
      dispositionNote: o.dispositionNote,
      promiseToPay: o.promiseToPay,
      callback: o.callback,
      transfer: o.transfer,
      messages: o.messages.map((m) => ({
        channel: m.channel,
        nodeId: m.nodeId,
        text: m.text,
        templateName: m.templateName,
        params: m.params,
      })),
    },
    costMicros: run.costMicros,
    endReason: run.endReason,
    contactName: state.contact.name ?? null,
    createdBy: run.createdBy
      ? { id: run.createdBy.toString(), name: users.get(run.createdBy.toString()) ?? '' }
      : null,
    createdAt: iso(run.createdAt),
    endedAt: run.endedAt ? iso(run.endedAt) : null,
    ...(full
      ? {
          transcript: run.transcript as unknown as TranscriptEntry[],
          trace: run.trace as unknown as TraceRow[],
        }
      : {}),
  };
};

// ── Engine wiring ───────────────────────────────────────────────────────────

const httpOptions = (deps: SimulatorDeps): HttpToolOptions => ({
  ...(deps.http ?? {}),
  policy: outgoingPolicy(deps.env, deps.extraPorts),
});

interface RunContact {
  display: Record<string, string>;
  phone: string | null;
  externalId: string | null;
  templateValues: Record<string, unknown>;
}

const loadContact = async (
  accountId: Types.ObjectId,
  contactId: Types.ObjectId,
): Promise<RunContact> => {
  const names = (await accountVariables(accountId)).map((v) => v.name);
  const { values } = await contactVariables(accountId, contactId, names);
  const contact = await ContactModel.findOne({ _id: contactId, accountId }).lean<ContactDoc>();
  if (!contact) throw new NotFoundError('Contact not found');
  return {
    display: values,
    phone: contact.phoneE164,
    externalId: contact.externalId ?? null,
    templateValues: contactTemplateValues(contact),
  };
};

const runContact = async (run: FlowRunDoc & { testPhone?: string | null }): Promise<RunContact> => {
  if (run.contactId) {
    try {
      return await loadContact(run.accountId, run.contactId);
    } catch {
      // contact deleted mid-run: keep going with what the run already knows
    }
  }
  const state = run.state as unknown as FlowRunState;
  return {
    display: state.contact,
    phone: run.testPhone ?? null,
    externalId: null,
    templateValues: run.testPhone ? { phone: run.testPhone, name: state.contact.name ?? '' } : {},
  };
};

/** Runs the engine once (plus automatic timer inputs for `wait` nodes). */
const step = async (
  run: {
    _id: Types.ObjectId;
    accountId: Types.ObjectId;
    flowId: Types.ObjectId;
    versionRef: 'draft' | number;
  },
  graph: FlowGraph,
  state: FlowRunState | null,
  input: FlowInput,
  contact: RunContact,
  deps: SimulatorDeps,
  seed: Record<string, RunValue> = {},
) => {
  const now = deps.now ?? (() => new Date());
  const account = await AccountModel.findById(run.accountId)
    .select({ name: 1 })
    .lean<{ name: string }>();
  const timezone = await accountTimezone(run.accountId);
  const stats = mongoStatsRecorder({
    accountId: run.accountId,
    flowId: run.flowId,
    version: run.versionRef === 'draft' ? 0 : run.versionRef,
    mode: 'simulator',
    timezone,
    now,
  });
  const ctx = { now, timezone, company: account?.name ?? '', mode: 'simulator' as const, stats };
  const effects = createFlowEffects({
    accountId: run.accountId,
    company: ctx.company,
    timezone,
    runId: run._id,
    mode: 'simulator',
    contact: {
      phone: contact.phone,
      externalId: contact.externalId,
      templateValues: contact.templateValues,
    },
    provider: deps.provider,
    textModel: deps.env.OPENAI_TEXT_MODEL,
    embeddingModel: deps.env.OPENAI_EMBEDDING_MODEL,
    secretKey: deps.secretKey,
    http: httpOptions(deps),
    now,
  });
  const results: AdvanceResult[] = [];
  let result = await advance(graph, state, input, effects, ctx, contact.display, seed);
  results.push(result);
  for (let n = 1; result.waiting?.kind === 'timer' && n <= FLOW_LIMITS.visitsPerNodeMax; n += 1) {
    result = await advance(
      graph,
      result.state,
      { kind: 'timer', inputId: `${input.inputId}:timer:${String(n)}` },
      effects,
      ctx,
    );
    results.push(result);
  }
  await stats.flush();
  return { result, results, now: now() };
};

/** Appends a step's transcript / trace / inputs and saves the run (optimistic on `state.seq`). */
const persist = async (
  run: FlowRunDoc,
  input: FlowInput,
  results: AdvanceResult[],
  at: Date,
  previousSeq: number | null,
) => {
  const last = results.at(-1)!;
  const transcript = [...(run.transcript as unknown as TranscriptEntry[])];
  const firstSeq = transcript.length + 1;
  const push = (e: Omit<TranscriptEntry, 'seq' | 'at'>) => {
    if (transcript.length < FLOW_LIMITS.transcriptRowsMax)
      transcript.push({ ...e, seq: transcript.length + 1, at: iso(at) });
  };
  entriesForInput(input).forEach(push);
  for (const r of results) r.outputs.flatMap(entriesForOutput).forEach(push);
  const added = transcript.slice(firstSeq - 1);
  const trace = [...(run.trace as unknown as TraceRow[])];
  for (const row of results.flatMap((r) => r.trace)) {
    if (trace.length < FLOW_LIMITS.traceRowsMax - 1) trace.push(row);
    else if (trace.length === FLOW_LIMITS.traceRowsMax - 1) {
      trace.push({
        seq: row.seq,
        at: row.at,
        nodeId: null,
        type: null,
        event: 'note',
        detail: 'trace truncated',
      });
    }
  }
  const cost = results
    .flatMap((r) => r.outputs)
    .reduce((sum, o) => sum + (o.type === 'ai_reply' ? o.costMicros : 0), 0);
  const update = {
    status: last.state.status,
    waiting: last.waiting,
    state: last.state,
    transcript,
    trace,
    costMicros: run.costMicros + cost,
    endReason: last.state.endReason,
    endedAt: last.state.endedAt ? new Date(last.state.endedAt) : null,
  };
  const saved = await FlowRunModel.findOneAndUpdate(
    { _id: run._id, ...(previousSeq === null ? {} : { 'state.seq': previousSeq }) },
    {
      $set: update,
      $push: {
        inputs: {
          inputId: input.inputId,
          kind: input.kind,
          at,
          seqFrom: firstSeq,
          seqTo: firstSeq + added.length - 1,
        },
      },
    },
    { returnDocument: 'after' },
  ).lean<FlowRunDoc>();
  if (!saved)
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Another input was just handled — reload the simulation.',
    );
  return { saved, added };
};

// ── API ─────────────────────────────────────────────────────────────────────

const findRun = async (flow: FlowDoc, runId: string, withPhone = false) => {
  const _id = toObjectId(runId);
  const query = _id
    ? FlowRunModel.findOne({ _id, accountId: flow.accountId, flowId: flow._id, mode: 'simulator' })
    : null;
  const run = query
    ? await (withPhone ? query.select('+testPhone') : query).lean<FlowRunDoc>()
    : null;
  if (!run) {
    throw new NotFoundError('Simulation not found');
  }
  return run;
};

/** Resolves `draft` / `published` / a number to a graph (+ snapshot for drafts). */
const resolveVersion = async (
  flow: FlowDoc,
  version: 'draft' | 'published' | number,
  deps: SimulatorDeps,
) => {
  if (version === 'draft') {
    const graph = FlowGraphSchema.parse(flow.draft);
    const issues = await issuesOf(flow.accountId, graph, deps);
    if (hasErrors(issues)) throw flowInvalid(issues);
    return { graph, versionRef: 'draft' as const, checksum: flow.draftChecksum ?? '' };
  }
  const number = version === 'published' ? flow.publishedVersion : version;
  if (!number)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This flow has no published version.');
  const v = await FlowVersionModel.findOne({
    flowId: flow._id,
    version: number,
  }).lean<FlowVersionDoc>();
  if (!v) throw new NotFoundError('Version not found');
  return { graph: v.graph as unknown as FlowGraph, versionRef: number, checksum: v.checksum };
};

export const startSimulation = async (
  req: Request,
  flowId: string,
  body: z.infer<typeof StartSimulationBody>,
  deps: SimulatorDeps,
) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, flowId);
  const { graph, versionRef, checksum } = await resolveVersion(flow, body.version, deps);

  let contact: RunContact;
  const seed: Record<string, RunValue> = {};
  const contactId = body.contactId ? toObjectId(body.contactId) : null;
  if (contactId) {
    contact = await loadContact(accountId, contactId);
  } else {
    const contactNames = new Set((await accountVariables(accountId)).map((v) => v.name));
    const flowTypes = new Map(graph.variables.map((v) => [v.name, v.type]));
    const display: Record<string, string> = {};
    const details: { path: string; message: string }[] = [];
    for (const [name, raw] of Object.entries(body.variables ?? {})) {
      const value = raw.trim();
      if (contactNames.has(name)) display[name] = value;
      else if (flowTypes.has(name)) {
        try {
          seed[name] = coerce(flowTypes.get(name) ?? 'text', value);
        } catch {
          details.push({
            path: `variables.${name}`,
            message: `Not a valid ${flowTypes.get(name) ?? 'value'}`,
          });
        }
      } else {
        details.push({
          path: `variables.${name}`,
          message: SYSTEM_VARIABLE_NAMES.has(name)
            ? 'Set by the flow — read-only'
            : 'Not a contact field or flow variable',
        });
      }
    }
    if (details.length) throw new ValidationError(details);
    if (body.testPhone && !display.phone_last4) display.phone_last4 = body.testPhone.slice(-4);
    contact = {
      display,
      phone: body.testPhone ?? null,
      externalId: null,
      templateValues: body.testPhone ? { phone: body.testPhone, name: display.name ?? '' } : {},
    };
  }

  const now = (deps.now ?? (() => new Date()))();
  const doc = await FlowRunModel.create({
    accountId,
    flowId: flow._id,
    mode: 'simulator',
    versionRef,
    graph: versionRef === 'draft' ? graph : null,
    graphChecksum: checksum,
    contactId,
    manualVariables: contactId ? null : (body.variables ?? null),
    testPhone: contactId ? null : (body.testPhone ?? null),
    createdBy: new Types.ObjectId(requireAuth(req).userId),
    expiresAt: new Date(now.getTime() + SIMULATOR_TTL_MS),
  });
  const run = doc.toObject({ transform: false }) as FlowRunDoc;
  const input: FlowInput = { kind: 'start', trigger: 'test', inputId: 'start' };
  const { results, now: at } = await step(run, graph, null, input, contact, deps, seed);
  const { saved, added } = await persist(run, input, results, at, null);
  return { run: await toRunView(saved, graph, false), added, replay: false };
};

export const sendInput = async (
  req: Request,
  flowId: string,
  runId: string,
  body: z.infer<typeof SimulationInputBody>,
  deps: SimulatorDeps,
) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, flowId);
  const run = await findRun(flow, runId, true);
  const graph = await graphOfRun(run);
  const previous = run.inputs.find((i) => i.inputId === body.clientInputId);
  if (previous) {
    const transcript = run.transcript as unknown as TranscriptEntry[];
    return {
      run: await toRunView(run, graph, false),
      added: transcript.filter((e) => e.seq >= previous.seqFrom && e.seq <= previous.seqTo),
      replay: true,
    };
  }
  if (run.status === 'ended')
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This simulation has ended.');
  const value = body.value ?? '';
  const input: FlowInput =
    body.kind === 'dtmf'
      ? { kind: 'dtmf', digits: value, inputId: body.clientInputId }
      : body.kind === 'speech'
        ? { kind: 'speech', text: value.trim(), inputId: body.clientInputId }
        : body.kind === 'transfer_result'
          ? {
              kind: 'transfer_result',
              result: value as 'connected' | 'failed' | 'no_answer',
              inputId: body.clientInputId,
            }
          : { kind: body.kind, inputId: body.clientInputId };
  const state = run.state as unknown as FlowRunState;
  try {
    const { results, now } = await step(run, graph, state, input, await runContact(run), deps);
    const { saved, added } = await persist(run, input, results, now, state.seq);
    return { run: await toRunView(saved, graph, false), added, replay: false };
  } catch (err) {
    if (err instanceof InputMismatchError) {
      throw new ValidationError([{ path: 'kind', message: err.message }]);
    }
    if (err instanceof RunEndedError)
      throw new ConflictError('CONFLICT_INVALID_STATE', 'This simulation has ended.');
    throw err;
  }
};

export const listSimulations = async (
  req: Request,
  flowId: string,
  query: z.infer<typeof ListSimulationsQuery>,
) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, flowId);
  const mine = query.mine === true;
  const runs = await FlowRunModel.find({
    accountId,
    flowId: flow._id,
    mode: 'simulator',
    ...(mine ? { createdBy: new Types.ObjectId(requireAuth(req).userId) } : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(FLOW_LIMITS.simulationsListed)
    .select({ transcript: 0, trace: 0, graph: 0 })
    .lean<FlowRunDoc[]>();
  const users = await userNames(runs.map((r) => r.createdBy));
  return runs.map((r) => {
    const s = r.state as unknown as FlowRunState;
    return {
      id: r._id.toString(),
      versionRef: r.versionRef,
      status: r.status,
      endReason: r.endReason,
      disposition: s.outcome.disposition,
      costMicros: r.costMicros,
      contactName: s.contact.name ?? null,
      createdBy: r.createdBy
        ? { id: r.createdBy.toString(), name: users.get(r.createdBy.toString()) ?? '' }
        : null,
      createdAt: iso(r.createdAt),
    };
  });
};

export const getSimulation = async (req: Request, flowId: string, runId: string) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, flowId);
  const run = await findRun(flow, runId);
  return toRunView(run, await graphOfRun(run), true);
};

/** Per-node counters for a version over days (account timezone). */
export const flowStats = async (
  req: Request,
  flowId: string,
  query: z.infer<typeof StatsQuery>,
) => {
  const { accountId } = tenantFilter(req);
  const flow = await findFlow(accountId, flowId);
  const today = ymdInZone(new Date(), await accountTimezone(accountId));
  const to = query.to ?? today;
  const from = query.from ?? addDays(to, -6);
  if (addDays(from, 92) < to)
    throw new ValidationError([{ path: 'from', message: 'At most 92 days' }]);
  const rows = await FlowNodeStatsModel.find({
    accountId,
    flowId: flow._id,
    version: query.version === 'draft' ? 0 : query.version,
    mode: query.mode,
    day: { $gte: from, $lte: to },
  }).lean<
    {
      nodeId: string;
      entered: number;
      errorCount: number;
      totalMs: number;
      exits: Record<string, number>;
    }[]
  >();
  const byNode = new Map<
    string,
    { entered: number; errors: number; totalMs: number; exits: Record<string, number> }
  >();
  for (const r of rows) {
    const acc = byNode.get(r.nodeId) ?? { entered: 0, errors: 0, totalMs: 0, exits: {} };
    acc.entered += r.entered;
    acc.errors += r.errorCount;
    acc.totalMs += r.totalMs;
    for (const [h, n] of Object.entries(r.exits)) acc.exits[h] = (acc.exits[h] ?? 0) + n;
    byNode.set(r.nodeId, acc);
  }
  return [...byNode].map(([nodeId, s]) => {
    const exits = Object.values(s.exits).reduce((a, b) => a + b, 0);
    return {
      nodeId,
      entered: s.entered,
      exits: s.exits,
      errors: s.errors,
      avgMs: exits ? Math.round(s.totalMs / exits) : 0,
    };
  });
};
