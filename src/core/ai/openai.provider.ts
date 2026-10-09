import { setTimeout as delay } from 'node:timers/promises';

import { AI_LIMITS } from '../../config/limits';
import { AppError } from '../../shared/errors/app-error';

import type {
  AiProvider,
  ChatMessage,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  ToolCall,
} from './types';

export interface OpenAiProviderOptions {
  apiKey: string;
  /** `https://api.openai.com/v1` (tests: a local stub). */
  baseUrl: string;
  /** Waits between retries (tests pass a fast one). */
  sleep?: (ms: number) => Promise<unknown>;
  /** Backoff before retry 1, 2 … (ms). */
  retryDelaysMs?: readonly number[];
  /** Per-request timeouts (default AI_LIMITS — tests use short ones). */
  timeoutsMs?: { chat: number; embed: number };
}

interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiChatResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAiEmbeddingResponse {
  data?: { index: number; embedding: number[] }[];
  usage?: { total_tokens?: number; prompt_tokens?: number };
}

const RETRY_AFTER_MAX_MS = 10_000;

const toOpenAiMessage = (m: ChatMessage): Record<string, unknown> => {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content };
};

const finishReason = (value: string | undefined): ChatResult['finishReason'] =>
  value === 'stop' || value === 'tool_calls' || value === 'length' ? value : 'other';

const unavailable = (status: number | string) =>
  new AppError('PROVIDER_UNAVAILABLE', 'The AI service is unavailable. Please try again.', [
    { path: 'provider', message: `openai ${String(status)}` },
  ]);
const rejected = (status: number | string) =>
  new AppError('PROVIDER_ERROR', 'The AI service rejected the request.', [
    { path: 'provider', message: `openai ${String(status)}` },
  ]);

const retryAfterMs = (header: string | null): number | null => {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, RETRY_AFTER_MAX_MS);
};

/**
 * OpenAI over REST (no SDK): Chat Completions with tools + Embeddings.
 * Retries 429 / 5xx / network / timeout (2 retries, Retry-After honoured);
 * never logs prompts, messages or the key (ADR 0033).
 */
export const createOpenAiProvider = ({
  apiKey,
  baseUrl,
  sleep = (ms) => delay(ms),
  retryDelaysMs = [500, 2000],
  timeoutsMs = { chat: AI_LIMITS.chatTimeoutMs, embed: AI_LIMITS.embedTimeoutMs },
}: OpenAiProviderOptions): AiProvider => {
  const base = baseUrl.replace(/\/+$/, '');

  const post = async <T>(
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> => {
    let lastStatus: number | string = 'network';
    for (let attempt = 0; attempt <= AI_LIMITS.providerRetries; attempt += 1) {
      let response: Response;
      try {
        const timeout = AbortSignal.timeout(timeoutMs);
        response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastStatus = (err as Error).name === 'TimeoutError' ? 'timeout' : 'network';
        if (attempt < AI_LIMITS.providerRetries) await sleep(retryDelaysMs[attempt] ?? 2000);
        continue;
      }
      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          throw rejected('invalid_json');
        }
      }
      lastStatus = response.status;
      const retryable = response.status === 429 || response.status >= 500;
      await response.body?.cancel();
      if (!retryable) throw rejected(response.status);
      if (attempt < AI_LIMITS.providerRetries) {
        await sleep(
          retryAfterMs(response.headers.get('retry-after')) ?? retryDelaysMs[attempt] ?? 2000,
        );
      }
    }
    throw unavailable(lastStatus);
  };

  return {
    name: 'openai',

    async chat(request: ChatRequest): Promise<ChatResult> {
      const body: Record<string, unknown> = {
        model: request.model,
        messages: request.messages.map(toOpenAiMessage),
        temperature: request.temperatureTenths / 10,
        max_completion_tokens: request.maxOutputTokens,
      };
      if (request.tools?.length) {
        body.tools = request.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }));
        body.tool_choice = 'auto';
      }
      const json = await post<OpenAiChatResponse>(
        '/chat/completions',
        body,
        timeoutsMs.chat,
        request.signal,
      );
      const choice = json.choices?.[0];
      if (!choice?.message) throw rejected('no_choice');
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? [])
        .filter((c) => c.type === 'function')
        .map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
      return {
        content: choice.message.content ?? '',
        toolCalls,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
        finishReason: finishReason(choice.finish_reason),
      };
    },

    async embed(request: EmbedRequest): Promise<EmbedResult> {
      if (!request.inputs.length) return { vectors: [], usage: { tokens: 0 } };
      const json = await post<OpenAiEmbeddingResponse>(
        '/embeddings',
        { model: request.model, input: request.inputs },
        timeoutsMs.embed,
        request.signal,
      );
      const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
      if (data.length !== request.inputs.length) throw rejected('embedding_count');
      return {
        vectors: data.map((d) => d.embedding),
        usage: { tokens: json.usage?.total_tokens ?? json.usage?.prompt_tokens ?? 0 },
      };
    },
  };
};
