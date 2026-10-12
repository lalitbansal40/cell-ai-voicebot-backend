import type { Disposition } from '../../db/models/ai-agent.model';
import type { RunEndReason, WaitingKind } from '../../db/models/flow-run.model';
import type { FlowTrigger } from '../../db/models/flow.model';

import type { IntentLike } from './intents';
import type { NodeConfig } from './schema';
import type { RunValue } from './variables';

// ── Inputs ──────────────────────────────────────────────────────────────────

export type FlowInputBody =
  | { kind: 'start'; trigger: FlowTrigger }
  | { kind: 'dtmf'; digits: string }
  | { kind: 'speech'; text: string }
  | { kind: 'no_input' }
  | { kind: 'timer' }
  | { kind: 'transfer_result'; result: 'connected' | 'failed' | 'no_answer' }
  /** The call ended outside the flow (calls pass why; default the customer hung up). */
  | { kind: 'hangup'; reason?: 'customer_hangup' | 'max_duration' | 'engine_error' }
  /** A live voice AI session (calls) finished the `ai_agent` step. */
  | {
      kind: 'ai_session_end';
      outcome: AiTurnResult['outcome'];
      reason: 'outcome' | 'end_call' | 'no_response' | 'max_turns' | 'fallback';
      turns: number;
    };

/** An input with its idempotency id (simulator `clientInputId`, call event id). */
export type FlowInput = FlowInputBody & { inputId: string };

// ── Outputs (actions for the host) ──────────────────────────────────────────

export interface AiToolCallView {
  name: string;
  kind: 'custom' | 'built_in';
  args: Record<string, unknown>;
  ok: boolean;
  simulated: boolean;
  durationMs: number;
  resultPreview: string | null;
  error: string | null;
}

export type FlowOutput =
  | {
      type: 'say';
      nodeId: string | null;
      text: string;
      language: 'hi' | 'en' | 'hinglish' | 'auto';
      voice: string;
      interruptible: boolean;
    }
  | { type: 'play'; nodeId: string; audioId: string; audioName: string }
  | {
      type: 'listen_dtmf';
      nodeId: string;
      timeoutSec: number;
      maxDigits: number;
      finishKey: '#' | 'none';
    }
  | { type: 'listen_speech'; nodeId: string; timeoutSec: number; language: string }
  | {
      type: 'ai_reply';
      nodeId: string;
      text: string;
      toolCalls: AiToolCallView[];
      knowledge: { title: string; snippet: string; score: number }[];
      costMicros: number;
      fallback: string | null;
      guardrail: string | null;
    }
  | { type: 'transfer'; nodeId: string | null; phone: string; timeoutSec: number }
  | { type: 'message_queued'; nodeId: string; channel: 'sms' | 'whatsapp'; preview: string }
  | { type: 'pause'; nodeId: string; seconds: number }
  | { type: 'note'; nodeId: string | null; text: string }
  | { type: 'hangup'; nodeId: string | null; reason: RunEndReason };

// ── State (plain JSON — Phase 7 keeps it in Redis, the simulator in Mongo) ──

export interface QueuedMessage {
  channel: 'sms' | 'whatsapp';
  nodeId: string;
  text: string | null;
  templateName: string | null;
  language: string | null;
  params: string[];
  dltTemplateId: string | null;
  queuedAt: string;
}

export interface RunOutcome {
  disposition: Disposition | null;
  dispositionNote: string | null;
  promiseToPay: { date: string; amountMicros: number | null } | null;
  callback: { date: string; time: string | null } | null;
  transfer: { result: 'connected' | 'failed' | 'no_answer' } | null;
  messages: QueuedMessage[];
}

export interface AiTurnLite {
  role: 'user' | 'assistant';
  text: string;
  clientTurnId: string | null;
}

export interface FlowRunState {
  status: 'running' | 'waiting' | 'ended';
  nodeId: string | null;
  waitingFor: WaitingKind | null;
  /** Retries used on the current gather visit. */
  retries: number;
  /** When the current node was entered (ISO) — node durations. */
  enteredAt: string | null;
  visits: Record<string, number>;
  steps: number;
  autoSteps: number;
  inputs: number;
  /** Contact values (display text: `name`, `phone_last4`, custom fields). */
  contact: Record<string, string>;
  /** Flow + system variables (typed). */
  variables: Record<string, RunValue>;
  outcome: RunOutcome;
  ai: {
    nodeId: string;
    agentId: string;
    turns: AiTurnLite[];
    turnCount: number;
    noInputs: number;
  } | null;
  /** In the flow error handler's transfer (any result ends the run). */
  inErrorHandler: boolean;
  trigger: FlowTrigger;
  startedAt: string;
  endedAt: string | null;
  endReason: RunEndReason | null;
  /** Last trace sequence number. */
  seq: number;
}

export interface TraceRow {
  seq: number;
  at: string;
  nodeId: string | null;
  type: string | null;
  event: 'entered' | 'exited' | 'error' | 'input' | 'output' | 'note';
  handle?: string;
  durationMs?: number;
  detail?: string;
}

export interface Waiting {
  kind: WaitingKind;
  nodeId: string;
  timeoutSec?: number;
  keys?: { key: string; label: string }[];
  mode?: 'menu' | 'digits';
  maxDigits?: number;
  finishKey?: '#' | 'none';
  seconds?: number;
  transferPhoneLast4?: string;
}

export interface AdvanceResult {
  state: FlowRunState;
  outputs: FlowOutput[];
  trace: TraceRow[];
  waiting: Waiting | null;
}

// ── Effects (injected) & context ────────────────────────────────────────────

export type ApiCallResult =
  | { ok: true; status: number; body: unknown; durationMs: number }
  | { ok: false; error: string; durationMs: number };

export interface AiStartResult {
  ok: boolean;
  /** Opening line (ok) or the fallback text to say (not ok). */
  text: string | null;
  /** `agent_missing`, `agentOff` … when not ok. */
  reason: string | null;
}

export interface AiTurnResult {
  text: string;
  outcome: {
    disposition?: Disposition;
    promiseToPay?: { date: string; amountMicros: number | null };
    callback?: { date: string; time: string | null };
    transferRequested?: boolean;
    endRequested?: boolean;
    smsTemplate?: string;
  };
  ended: boolean;
  /** `agentOff`, `walletEmpty`, `capReached`, `aiFailed` → the node's error exit. */
  fallback: string | null;
  guardrail: string | null;
  toolCalls: AiToolCallView[];
  knowledge: { title: string; snippet: string; score: number }[];
  costMicros: number;
}

export interface FlowEffects {
  callApi(input: {
    nodeId: string;
    config: NodeConfig<'api_request'>;
    values: Record<string, string>;
  }): Promise<ApiCallResult>;
  aiStart(input: {
    nodeId: string;
    config: NodeConfig<'ai_agent'>;
    values: Record<string, string>;
  }): Promise<AiStartResult>;
  aiTurn(input: {
    nodeId: string;
    config: NodeConfig<'ai_agent'>;
    values: Record<string, string>;
    turns: AiTurnLite[];
    userText: string;
    inputId: string;
  }): Promise<AiTurnResult>;
  classifyIntent(input: {
    nodeId: string;
    text: string;
    intents: readonly (IntentLike & { label: string })[];
    inputId: string;
  }): Promise<string | null>;
  /** Audio name when the file exists (ready, not deleted), else `null`. */
  loadAudio(audioId: string): Promise<{ id: string; name: string } | null>;
}

export interface StatsEvent {
  nodeId: string;
  event: 'enter' | 'exit' | 'error';
  handle?: string;
  ms?: number;
}

/** Collects node counters; the host flushes them (Mongo `$inc`) after `advance`. */
export interface StatsRecorder {
  record(event: StatsEvent): void;
}

export interface EngineContext {
  now(): Date;
  timezone: string;
  company: string;
  mode: 'simulator' | 'call';
  stats: StatsRecorder;
}
