import type { Types } from 'mongoose';

import { AgentToolCallModel, TOOL_CALL_TTL_MS } from '../../db/models/agent-tool-call.model';

import { redactArgs, redactPreview } from './redact';

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
