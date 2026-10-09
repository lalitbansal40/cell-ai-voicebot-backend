/** AI provider contract (PHASE_5_PLAN §1a, ADR 0033). */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** Provider id of the call (sent back with the tool result). */
  id: string;
  name: string;
  /** JSON text exactly as the model produced it (validated before use). */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant messages that asked for tools. */
  toolCalls?: ToolCall[];
  /** Tool results: which call they answer. */
  toolCallId?: string;
}

/** JSON Schema of a tool's arguments (object, our parameter subset). */
export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required: string[];
  additionalProperties: false;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  /** 0–1.2 in tenths (12 = 1.2). */
  temperatureTenths: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'other';
}

export interface EmbedRequest {
  model: string;
  inputs: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  usage: { tokens: number };
}

export interface AiProvider {
  readonly name: 'openai' | 'fake';
  chat(request: ChatRequest): Promise<ChatResult>;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}
