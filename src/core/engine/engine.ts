import { FLOW_LIMITS } from '../../config/limits';
import type { RunEndReason, WaitingKind } from '../../db/models/flow-run.model';
import type { FlowTrigger, NodeType } from '../../db/models/flow.model';
import { ymdInZone } from '../../shared/time';

import { AI_EXITS } from './exits';
import { NODE_HANDLERS } from './nodes';
import type { NodeHandler, NodeRuntime, Step } from './runtime';
import { parseNodeConfig, type FlowGraph, type FlowNode, type TypedNode } from './schema';
import { traceDetail } from './trace';
import type {
  AdvanceResult,
  EngineContext,
  FlowEffects,
  FlowInput,
  FlowOutput,
  FlowRunState,
  TraceRow,
  Waiting,
} from './types';
import {
  SYSTEM_VARIABLES,
  coerce,
  displayValue,
  flowTemplate,
  type RunValue,
  type ValueType,
} from './variables';

/** The input kind does not match what the run waits for (API → 422). */
export class InputMismatchError extends Error {
  constructor(
    readonly expected: WaitingKind | null,
    readonly got: FlowInput['kind'],
  ) {
    super(expected ? `Waiting for ${expected}` : 'Not waiting for input');
    this.name = 'InputMismatchError';
  }
}

/** The run already ended (API → 409). */
export class RunEndedError extends Error {
  constructor() {
    super('This run has ended');
    this.name = 'RunEndedError';
  }
}

const ACCEPTS: Record<WaitingKind, readonly FlowInput['kind'][]> = {
  dtmf: ['dtmf', 'no_input'],
  speech: ['speech', 'no_input'],
  ai: ['speech', 'no_input'],
  transfer: ['transfer_result'],
  timer: ['timer'],
};

const SYSTEM_TYPES = new Map<string, ValueType>(SYSTEM_VARIABLES.map((v) => [v.name, v.type]));
const AI_OUTCOME_EXITS = new Set(
  AI_EXITS.map((e) => e.handle).filter((h) => h !== 'resolved' && h !== 'error'),
);
const IN_PHONE = /^\+91[6-9]\d{9}$/;

const timeIn = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);

/** First state of a run: flow variable defaults, empty system variables. */
export const initialState = (
  graph: FlowGraph,
  ctx: Pick<EngineContext, 'now' | 'company'>,
  trigger: FlowTrigger,
  contact: Record<string, string>,
): FlowRunState => {
  const variables: Record<string, RunValue> = {};
  for (const v of SYSTEM_VARIABLES) variables[v.name] = null;
  variables.company = ctx.company;
  for (const v of graph.variables) {
    try {
      variables[v.name] = v.default === undefined ? null : coerce(v.type, v.default);
    } catch {
      variables[v.name] = null;
    }
  }
  return {
    status: 'running',
    nodeId: null,
    waitingFor: null,
    retries: 0,
    enteredAt: null,
    visits: {},
    steps: 0,
    autoSteps: 0,
    inputs: 0,
    contact,
    variables,
    outcome: {
      disposition: null,
      dispositionNote: null,
      promiseToPay: null,
      callback: null,
      transfer: null,
      messages: [],
    },
    ai: null,
    inErrorHandler: false,
    trigger,
    startedAt: ctx.now().toISOString(),
    endedAt: null,
    endReason: null,
    seq: 0,
  };
};

class Run implements NodeRuntime {
  readonly outputs: FlowOutput[] = [];
  readonly trace: TraceRow[] = [];
  waiting: Waiting | null = null;
  private readonly nodes: Map<string, FlowNode>;
  private readonly edges: Map<string, string>;
  private readonly flowTypes: Map<string, ValueType>;

  constructor(
    readonly graph: FlowGraph,
    readonly state: FlowRunState,
    readonly ctx: EngineContext,
    readonly effects: FlowEffects,
    readonly inputId: string,
  ) {
    this.nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    this.edges = new Map(graph.edges.map((e) => [`${e.source}\u0000${e.sourceHandle}`, e.target]));
    this.flowTypes = new Map(graph.variables.map((v) => [v.name, v.type]));
  }

  get settings() {
    return this.graph.settings;
  }

  // ── NodeRuntime ───────────────────────────────────────────────────────────

  values(): Record<string, string> {
    const lang = this.settings.language;
    const out: Record<string, string> = { ...this.state.contact };
    for (const [name, value] of Object.entries(this.state.variables)) {
      out[name] = displayValue(this.varType(name), value, lang);
    }
    return out;
  }

  render(text: string, nodeId: string): string {
    const warnings = new Set<string>();
    const result = flowTemplate.renderText(text, { values: this.values() }, warnings);
    for (const w of warnings) this.addTrace({ nodeId, event: 'note', detail: w }, 'safe');
    return result;
  }

  say(
    nodeId: string | null,
    text: string,
    opts: { language?: string; interruptible?: boolean } = {},
  ) {
    const language =
      !opts.language || opts.language === 'flow' ? this.settings.language : opts.language;
    this.push({
      type: 'say',
      nodeId,
      text,
      language: language as 'hi' | 'en' | 'hinglish' | 'auto',
      voice: this.settings.voice,
      interruptible: opts.interruptible ?? true,
    });
  }

  push(output: FlowOutput) {
    this.outputs.push(output);
    const detail =
      output.type === 'say' || output.type === 'ai_reply'
        ? output.text
        : output.type === 'message_queued'
          ? output.preview
          : output.type === 'note'
            ? output.text
            : undefined;
    this.addTrace(
      { nodeId: output.nodeId, event: 'output', handle: output.type, detail },
      output.type === 'note' ? 'safe' : 'text',
    );
  }

  note(nodeId: string | null, text: string) {
    this.push({ type: 'note', nodeId, text });
  }

  getVar(name: string): RunValue {
    if (Object.hasOwn(this.state.variables, name)) return this.state.variables[name] ?? null;
    return Object.hasOwn(this.state.contact, name) ? (this.state.contact[name] ?? null) : null;
  }

  varType(name: string): ValueType {
    return this.flowTypes.get(name) ?? SYSTEM_TYPES.get(name) ?? 'text';
  }

  setVar(name: string, value: RunValue) {
    this.state.variables[name] = value;
  }

  fail(nodeId: string, detail: string): Step {
    this.addTrace({ nodeId, event: 'error', detail }, 'safe');
    this.ctx.stats.record({ nodeId, event: 'error' });
    return { exit: 'error' };
  }

  // ── Engine loop ───────────────────────────────────────────────────────────

  addTrace(
    row: Omit<TraceRow, 'seq' | 'at' | 'type'> & { type?: string | null },
    kind: 'text' | 'safe' = 'text',
  ) {
    this.state.seq += 1;
    const node = row.nodeId ? this.nodes.get(row.nodeId) : undefined;
    const detail = traceDetail(this.ctx.mode, row.detail, kind);
    this.trace.push({
      seq: this.state.seq,
      at: this.ctx.now().toISOString(),
      nodeId: row.nodeId,
      type: row.type ?? node?.type ?? null,
      event: row.event,
      ...(row.handle === undefined ? {} : { handle: row.handle }),
      ...(row.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      ...(detail === undefined ? {} : { detail }),
    });
  }

  node(id: string | null): FlowNode | undefined {
    return id ? this.nodes.get(id) : undefined;
  }

  private handler(type: NodeType): NodeHandler {
    return NODE_HANDLERS[type];
  }

  private typed(node: FlowNode): TypedNode | null {
    const parsed = parseNodeConfig(node.type, node.config);
    return parsed.ok ? { ...node, config: parsed.config } : null;
  }

  private elapsedMs(): number {
    return this.state.enteredAt ? this.ctx.now().getTime() - Date.parse(this.state.enteredAt) : 0;
  }

  async enter(node: FlowNode): Promise<Step> {
    const s = this.state;
    s.steps += 1;
    s.autoSteps += 1;
    s.visits[node.id] = (s.visits[node.id] ?? 0) + 1;
    s.nodeId = node.id;
    s.enteredAt = this.ctx.now().toISOString();
    s.waitingFor = null;
    s.retries = 0;
    this.addTrace({ nodeId: node.id, event: 'entered' });
    this.ctx.stats.record({ nodeId: node.id, event: 'enter' });
    if (
      s.steps > FLOW_LIMITS.stepsPerRunMax ||
      (s.visits[node.id] ?? 0) > FLOW_LIMITS.visitsPerNodeMax ||
      s.autoSteps > FLOW_LIMITS.autoStepsMax
    ) {
      this.addTrace({ nodeId: node.id, event: 'error', detail: 'loop guard' }, 'safe');
      this.say(null, this.settings.errorMessage);
      return { end: 'loop_guard' };
    }
    const typed = this.typed(node);
    if (!typed) return this.fail(node.id, 'node is not configured');
    return this.handler(node.type).enter(typed, this);
  }

  async input(node: FlowNode, input: FlowInput): Promise<Step> {
    const typed = this.typed(node);
    const handler = this.handler(node.type);
    if (!typed || !handler.input) return this.fail(node.id, 'node cannot take input');
    return handler.input(typed, input, this);
  }

  private follow(node: FlowNode, handle: string): FlowNode | undefined {
    const target = (h: string) => {
      const id = this.edges.get(`${node.id}\u0000${h}`);
      return id ? this.nodes.get(id) : undefined;
    };
    return (
      target(handle) ??
      (AI_OUTCOME_EXITS.has(handle) ? target('resolved') : undefined) ??
      (handle !== 'error' ? target('error') : undefined)
    );
  }

  /** The flow error handler: error message, then hang up or transfer. */
  private errorHandler(nodeId: string | null): Step {
    this.say(null, this.settings.errorMessage);
    const phone = this.settings.errorTransferPhone ?? '';
    if (this.settings.onError === 'transfer' && IN_PHONE.test(phone)) {
      this.state.inErrorHandler = true;
      this.push({
        type: 'transfer',
        nodeId: null,
        phone,
        timeoutSec: FLOW_LIMITS.transferTimeoutSecDefault,
      });
      return {
        wait: {
          kind: 'transfer',
          nodeId: nodeId ?? this.state.nodeId ?? '',
          timeoutSec: FLOW_LIMITS.transferTimeoutSecDefault,
          transferPhoneLast4: phone.slice(-4),
        },
      };
    }
    return { end: 'error_handler' };
  }

  finish(reason: RunEndReason) {
    const s = this.state;
    const node = this.node(s.nodeId);
    if (node && s.status !== 'ended') {
      this.ctx.stats.record({
        nodeId: node.id,
        event: 'exit',
        handle: 'end',
        ms: this.elapsedMs(),
      });
    }
    s.status = 'ended';
    s.waitingFor = null;
    s.endReason = reason;
    s.endedAt = this.ctx.now().toISOString();
    this.waiting = null;
    if (reason !== 'transferred' && reason !== 'customer_hangup') {
      this.push({ type: 'hangup', nodeId: node?.id ?? null, reason });
    }
    this.addTrace({ nodeId: node?.id ?? null, event: 'note', detail: `ended: ${reason}` }, 'safe');
  }

  /** Follows exits until a node waits or the run ends. */
  async drive(first: Step, from: FlowNode | null): Promise<void> {
    let step = first;
    let node = from;
    for (;;) {
      if ('wait' in step) {
        this.state.status = 'waiting';
        this.state.waitingFor = step.wait.kind;
        this.waiting = step.wait;
        return;
      }
      if ('end' in step) {
        this.finish(step.end);
        return;
      }
      if (!node) {
        this.finish('engine_error');
        return;
      }
      this.addTrace({
        nodeId: node.id,
        event: 'exited',
        handle: step.exit,
        durationMs: this.elapsedMs(),
      });
      this.ctx.stats.record({
        nodeId: node.id,
        event: 'exit',
        handle: step.exit,
        ms: this.elapsedMs(),
      });
      const next = this.follow(node, step.exit);
      if (!next) {
        step = this.errorHandler(node.id);
        continue;
      }
      node = next;
      step = await this.enter(next);
    }
  }
}

/** Refreshes `today` / `now_time` (account timezone) before each step. */
const refreshClock = (state: FlowRunState, ctx: EngineContext) => {
  const now = ctx.now();
  state.variables.today = ymdInZone(now, ctx.timezone);
  state.variables.now_time = timeIn(now, ctx.timezone);
};

/**
 * Runs the flow from its current position with one input until a node waits
 * or the run ends (PHASE_6_PLAN §1f). Side effects only through `effects`.
 * `state` is `null` for the `start` input; otherwise the JSON from the last call.
 */
export const advance = async (
  graph: FlowGraph,
  previous: FlowRunState | null,
  input: FlowInput,
  effects: FlowEffects,
  ctx: EngineContext,
  contact: Record<string, string> = {},
): Promise<AdvanceResult & { error?: string }> => {
  let state: FlowRunState;
  if (input.kind === 'start') {
    state = initialState(graph, ctx, input.trigger, contact);
  } else {
    if (!previous) throw new RunEndedError();
    state = structuredClone(previous);
    if (state.status === 'ended') throw new RunEndedError();
  }
  const run = new Run(graph, state, ctx, effects, input.inputId);
  refreshClock(state, ctx);
  try {
    if (input.kind === 'start') {
      run.addTrace(
        { nodeId: null, event: 'input', handle: 'start', detail: input.trigger },
        'safe',
      );
      const start = graph.nodes.find((n) => n.type === 'start');
      if (!start) {
        run.finish('engine_error');
      } else {
        await run.drive(await run.enter(start), start);
      }
    } else if (input.kind === 'hangup') {
      run.addTrace({ nodeId: state.nodeId, event: 'input', handle: 'hangup' }, 'safe');
      run.finish('customer_hangup');
    } else {
      const kind = state.waitingFor;
      if (!kind || !ACCEPTS[kind].includes(input.kind))
        throw new InputMismatchError(kind, input.kind);
      const detail =
        input.kind === 'dtmf'
          ? input.digits
          : input.kind === 'speech'
            ? input.text
            : input.kind === 'transfer_result'
              ? input.result
              : undefined;
      run.addTrace({ nodeId: state.nodeId, event: 'input', handle: input.kind, detail }, 'text');
      state.inputs += 1;
      state.autoSteps = 0;
      const tooLong =
        ctx.now().getTime() - Date.parse(state.startedAt) > graph.settings.maxDurationSec * 1000;
      if (tooLong) {
        run.finish('max_duration');
      } else if (state.inputs > FLOW_LIMITS.inputsPerRunMax) {
        run.finish('inputs_exhausted');
      } else if (state.inErrorHandler) {
        run.finish(
          input.kind === 'transfer_result' && input.result === 'connected'
            ? 'transferred'
            : 'error_handler',
        );
      } else {
        const node = run.node(state.nodeId);
        if (!node) {
          run.finish('engine_error');
        } else {
          state.status = 'running';
          await run.drive(await run.input(node, input), node);
        }
      }
    }
  } catch (err) {
    if (err instanceof InputMismatchError || err instanceof RunEndedError) throw err;
    run.addTrace({ nodeId: state.nodeId, event: 'error', detail: 'engine error' }, 'safe');
    run.finish('engine_error');
    return {
      state,
      outputs: run.outputs,
      trace: run.trace,
      waiting: null,
      error: err instanceof Error ? err.name : 'unknown',
    };
  }
  return { state, outputs: run.outputs, trace: run.trace, waiting: run.waiting };
};
