import type { Types } from 'mongoose';

import type { PlaygroundTurn } from '../../db/models/agent-playground-session.model';
import type { AiAgentDoc, BuiltInTool } from '../../db/models/ai-agent.model';
import { BUILT_IN_TOOLS } from '../../db/models/ai-agent.model';

import { executeFunction, type HttpToolOptions } from './http-tool';
import { redactArgs, redactPreview } from './redact';
import { logToolCall } from './tool-log';
import { argumentsValidator, executeBuiltIn, type BuiltInOutcome } from './tools';
import type { ToolCall } from './types';

export interface ToolRunnerInput {
  accountId: Types.ObjectId;
  agent: AiAgentDoc;
  /** Playground session / flow run / call — the tool log groups by it. */
  sessionId: Types.ObjectId;
  source?: 'playground' | 'call' | 'flow_simulator';
  now: Date;
  timezone: string;
  company: string;
  /** `{{contact.*}}` values for functions only — never sent to the model. */
  contact: Record<string, unknown>;
  secretKey: Buffer;
  http: HttpToolOptions;
  builtInMode?: 'simulated' | 'live';
}

export interface ToolRunner {
  /** Runs one tool call; returns the text the model sees. */
  run(call: ToolCall): Promise<string>;
  /** Calls so far (redacted, for the turn record). */
  readonly toolCalls: PlaygroundTurn['toolCalls'];
  /** Outcome fields the built-ins set. */
  readonly outcome: BuiltInOutcome;
  /** Waits for the tool-log writes. */
  flush(): Promise<void>;
}

/**
 * Tool execution shared by text turns and live voice sessions: built-ins
 * (simulated or live), custom functions through the secure executor, bad
 * arguments refused before any request, every call logged without secrets.
 */
export const createToolRunner = (input: ToolRunnerInput): ToolRunner => {
  const { agent, accountId } = input;
  const toolCalls: PlaygroundTurn['toolCalls'] = [];
  const logs: Promise<void>[] = [];
  const outcome: BuiltInOutcome = {};

  const run = async (call: ToolCall): Promise<string> => {
    const started = Date.now();
    const record = (
      entry: Omit<PlaygroundTurn['toolCalls'][number], 'durationMs'>,
      log: { httpStatus?: number | null; bytes: number; text: string },
    ) => {
      toolCalls.push({ ...entry, durationMs: Date.now() - started });
      logs.push(
        logToolCall({
          accountId,
          agentId: agent._id,
          sessionId: input.sessionId,
          source: input.source ?? 'playground',
          tool: call.name.slice(0, 60),
          kind: entry.kind,
          args: entry.args,
          ok: entry.ok,
          httpStatus: log.httpStatus ?? null,
          durationMs: Date.now() - started,
          resultBytes: log.bytes,
          resultText: log.text,
          errorCode: entry.error,
          now: input.now,
        }).then(() => undefined),
      );
    };
    let args: Record<string, unknown> = {};
    let argsOk = true;
    try {
      const parsed: unknown = call.arguments ? JSON.parse(call.arguments) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        args = parsed as Record<string, unknown>;
      else argsOk = false;
    } catch {
      argsOk = false;
    }

    if ((BUILT_IN_TOOLS as readonly string[]).includes(call.name)) {
      const out = argsOk
        ? executeBuiltIn(call.name as BuiltInTool, args, {
            agent,
            mode: input.builtInMode ?? 'simulated',
            now: input.now,
            timezone: input.timezone,
          })
        : { result: { ok: false, error: 'invalid_arguments' }, outcome: {} };
      Object.assign(outcome, out.outcome);
      const text = JSON.stringify(out.result);
      const ok = out.result.ok === true;
      record(
        {
          name: call.name,
          kind: 'built_in',
          args: redactArgs(args),
          ok,
          simulated: ok && input.builtInMode !== 'live',
          resultPreview: redactPreview(text),
          error: ok ? null : String(out.result.error),
        },
        { bytes: text.length, text },
      );
      return text;
    }

    const fn = agent.functions.find((f) => f.name === call.name);
    if (!fn) {
      const text = JSON.stringify({ ok: false, error: 'unknown_tool' });
      record(
        {
          name: call.name.slice(0, 60),
          kind: 'custom',
          args: {},
          ok: false,
          simulated: false,
          resultPreview: null,
          error: 'unknown_tool',
        },
        { bytes: 0, text: '' },
      );
      return text;
    }
    const checked = argsOk ? argumentsValidator(fn.parameters).safeParse(args) : null;
    if (!checked?.success) {
      // bad arguments never reach the API — the model is told and may retry
      const details =
        checked?.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) ?? [];
      const text = JSON.stringify({ ok: false, error: 'invalid_arguments', details });
      record(
        {
          name: fn.name,
          kind: 'custom',
          args: redactArgs(args),
          ok: false,
          simulated: false,
          resultPreview: null,
          error: 'invalid_arguments',
        },
        { bytes: 0, text: '' },
      );
      return text;
    }
    const out = await executeFunction(
      fn,
      {
        args: checked.data,
        contact: input.contact,
        agentName: agent.name,
        company: input.company,
      },
      input.secretKey,
      input.http,
    );
    record(
      {
        name: fn.name,
        kind: 'custom',
        args: redactArgs(checked.data),
        ok: out.ok,
        simulated: false,
        resultPreview: redactPreview(out.resultText),
        error: out.error ?? null,
      },
      { httpStatus: out.httpStatus, bytes: out.bytes, text: out.resultText },
    );
    return out.ok ? out.resultText : JSON.stringify({ ok: false, error: out.error });
  };

  return {
    run,
    toolCalls,
    outcome,
    flush: async () => {
      await Promise.allSettled(logs);
    },
  };
};
