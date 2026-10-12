import { z } from 'zod';

import type { RealtimeUsage } from './types';

/** OpenAI Realtime server events we act on (GA names, voice-ai-poc-results.md §1). */
const UsageSchema = z
  .object({
    input_token_details: z
      .object({
        text_tokens: z.number().optional(),
        audio_tokens: z.number().optional(),
        cached_tokens: z.number().optional(),
      })
      .partial()
      .optional(),
    output_token_details: z
      .object({ text_tokens: z.number().optional(), audio_tokens: z.number().optional() })
      .partial()
      .optional(),
  })
  .passthrough();

export const RealtimeServerEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.created') }).passthrough(),
  z.object({ type: z.literal('session.updated') }).passthrough(),
  z.object({ type: z.literal('input_audio_buffer.speech_started') }).passthrough(),
  z.object({ type: z.literal('input_audio_buffer.speech_stopped') }).passthrough(),
  z
    .object({
      type: z.literal('conversation.item.input_audio_transcription.completed'),
      transcript: z.string(),
      language: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('response.output_audio.delta'),
      item_id: z.string(),
      delta: z.string(),
    })
    .passthrough(),
  z
    .object({ type: z.literal('response.output_audio_transcript.done'), transcript: z.string() })
    .passthrough(),
  z
    .object({
      type: z.literal('response.function_call_arguments.done'),
      call_id: z.string(),
      name: z.string(),
      arguments: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('response.done'),
      response: z
        .object({ status: z.string().optional(), usage: UsageSchema.optional() })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('error'),
      error: z.object({ code: z.string().nullish(), type: z.string().nullish() }).passthrough(),
    })
    .passthrough(),
]);
export type RealtimeServerEvent = z.infer<typeof RealtimeServerEvent>;

/** Parsed event, or `null` for events we don't use / can't read (counted by the caller). */
export const parseRealtimeEvent = (raw: unknown): RealtimeServerEvent | null => {
  let value: unknown = raw;
  if (Buffer.isBuffer(raw)) value = raw.toString('utf8');
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const parsed = RealtimeServerEvent.safeParse(value);
  return parsed.success ? parsed.data : null;
};

export const usageOf = (usage: z.infer<typeof UsageSchema> | undefined): RealtimeUsage => ({
  inputAudioTokens: usage?.input_token_details?.audio_tokens ?? 0,
  outputAudioTokens: usage?.output_token_details?.audio_tokens ?? 0,
  inputTextTokens: usage?.input_token_details?.text_tokens ?? 0,
  outputTextTokens: usage?.output_token_details?.text_tokens ?? 0,
  cachedTokens: usage?.input_token_details?.cached_tokens ?? 0,
});
