import type { BuiltInOutcome } from '../../ai/tools';
import type { ToolDefinition } from '../../ai/types';

import type { TypedEmitter } from './emitter';

export interface RealtimeUsage {
  inputAudioTokens: number;
  outputAudioTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  cachedTokens: number;
}

export interface VoiceToolCall {
  callId: string;
  name: string;
  /** JSON text as produced by the model. */
  args: string;
}

/** A chat-backed session finished a turn itself (tools ran inside `runAgentTurn`). */
export interface TurnDone {
  text: string;
  outcome: BuiltInOutcome;
  ended: boolean;
  fallback: string | null;
  toolCalls: { name: string; ok: boolean }[];
}

export interface VoiceSessionEvents {
  speech_started: () => void;
  speech_stopped: () => void;
  customer_transcript: (e: { text: string; final: boolean; language: string | null }) => void;
  /** Bot audio at the session rate. */
  bot_audio: (pcm: Int16Array) => void;
  bot_transcript: (e: { text: string }) => void;
  /** The model finished a response (audio fully sent). */
  bot_done: () => void;
  tool_call: (call: VoiceToolCall) => void;
  turn_done: (turn: TurnDone) => void;
  usage: (usage: RealtimeUsage) => void;
  /** `fatal` → the session can't continue (socket gone, auth). */
  error: (e: { code: string; fatal: boolean }) => void;
}

export interface VoiceSessionOptions {
  instructions: string;
  voice: string;
  tools: ToolDefinition[];
  /** Customer speech interrupts the bot (server VAD `interrupt_response`). */
  bargeIn: boolean;
  /** 24 kHz PCM16 (web) or 8 kHz μ-law (phone). */
  rate: 24_000 | 8_000;
  /** Language hint for transcription (`hi`, `en`) or null (auto). */
  language: string | null;
  /** TTS language for the chat pipeline (`hi`, `en`, `hinglish`). */
  speechLanguage: string;
  /** Chat pipeline only: one agent turn (tools, knowledge, guardrails) for the customer's words. */
  turn?: ChatTurn;
}

export type ChatTurn = (text: string) => Promise<TurnDone>;

export interface AiVoiceSession extends Pick<TypedEmitter<VoiceSessionEvents>, 'on'> {
  readonly kind: 'realtime' | 'chat';
  sendAudio(pcm: Int16Array): void;
  /** Typed customer words (tests / dev text box) — a final customer turn. */
  sendText(text: string): void;
  /** Outputs for the tool calls of the last response; the model continues. */
  submitToolResults(results: { callId: string; output: string }[]): void;
  /** Barge-in: the bot was heard for `playedMs` of its current reply. */
  truncate(playedMs: number): void;
  /** Speaks a fixed line (opening line, silence prompt). */
  say(text: string): void;
  close(): Promise<void>;
}

export interface VoiceAiProvider {
  readonly name: 'openai' | 'fake';
  readonly pipeline: 'realtime' | 'chat';
  open(options: VoiceSessionOptions): Promise<AiVoiceSession>;
}

export interface TtsRequest {
  text: string;
  voice: string;
  /** `hi`, `en`, `hinglish`. */
  language: string;
  /** Optional delivery note (calm, empathetic …). */
  tone?: string;
}

export interface TtsProvider {
  readonly name: 'openai' | 'fake';
  readonly model: string;
  /** PCM16 mono 24 kHz. */
  synthesize(request: TtsRequest): Promise<Int16Array>;
}

export interface SttEvents {
  speech_started: () => void;
  speech_stopped: () => void;
  final: (e: { text: string; language: string | null }) => void;
  error: (e: { code: string; fatal: boolean }) => void;
}

export interface SttSession extends Pick<TypedEmitter<SttEvents>, 'on'> {
  sendAudio(pcm: Int16Array): void;
  sendText(text: string): void;
  close(): Promise<void>;
}

export interface SttProvider {
  readonly name: 'openai' | 'fake';
  open(options: { language: string | null; rate: 24_000 | 8_000 }): Promise<SttSession>;
}

/** What a socket must offer (the `ws` WebSocket fits; tests pass a fake). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number): void;
  on(event: 'message', fn: (data: unknown) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
  once(event: 'open', fn: () => void): unknown;
  once(event: 'error', fn: (err: Error) => void): unknown;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;
