/**
 * USD prices per 1M tokens / per minute.
 * Source: https://developers.openai.com/api/docs/pricing — checked 2026-10-08.
 * Re-check before using the numbers for client pricing.
 */
export interface RealtimePrice {
  textIn: number;
  textCachedIn: number;
  textOut: number;
  audioIn: number;
  audioCachedIn: number;
  audioOut: number;
}

export const REALTIME_PRICES: Record<string, RealtimePrice> = {
  'gpt-realtime-2.1': {
    textIn: 4,
    textCachedIn: 0.4,
    textOut: 24,
    audioIn: 32,
    audioCachedIn: 0.4,
    audioOut: 64,
  },
  'gpt-realtime-2.1-mini': {
    textIn: 0.6,
    textCachedIn: 0.06,
    textOut: 2.4,
    audioIn: 10,
    audioCachedIn: 0.3,
    audioOut: 20,
  },
};

/** gpt-4o-mini-tts: $0.60 / 1M text input tokens, $12 / 1M audio output tokens. */
export const TTS_PRICE = { textIn: 0.6, audioOut: 12 };

/** Input transcription, USD per audio minute. */
export const TRANSCRIBE_PER_MIN: Record<string, number> = {
  'gpt-4o-mini-transcribe': 0.003,
  'gpt-4o-transcribe': 0.006,
  'whisper-1': 0.006,
};

export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    text_tokens?: number;
    audio_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { text_tokens?: number; audio_tokens?: number };
  };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

/** Cost in USD of one `response.done` usage block. */
export const realtimeCostUsd = (model: string, usage: RealtimeUsage | undefined): number => {
  if (!usage) return 0;
  const price = REALTIME_PRICES[model];
  if (!price) throw new Error(`No pricing for model ${model} — add it to src/pricing.ts`);
  const inDetails = usage.input_token_details ?? {};
  const cached = inDetails.cached_tokens_details ?? {};
  const cachedText = cached.text_tokens ?? 0;
  const cachedAudio = cached.audio_tokens ?? 0;
  const textIn = Math.max(0, (inDetails.text_tokens ?? 0) - cachedText);
  const audioIn = Math.max(0, (inDetails.audio_tokens ?? 0) - cachedAudio);
  const out = usage.output_token_details ?? {};
  const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;
  return (
    textIn * perToken(price.textIn) +
    cachedText * perToken(price.textCachedIn) +
    audioIn * perToken(price.audioIn) +
    cachedAudio * perToken(price.audioCachedIn) +
    (out.text_tokens ?? 0) * perToken(price.textOut) +
    (out.audio_tokens ?? 0) * perToken(price.audioOut)
  );
};

export const transcriptionCostUsd = (model: string, audioMs: number): number =>
  (TRANSCRIBE_PER_MIN[model] ?? 0) * (audioMs / 60_000);
