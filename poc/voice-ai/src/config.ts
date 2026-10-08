import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** PoC configuration. Values come from the backend `.env` (loaded via `--env-file-if-exists`). */
export const POC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT_DIR = path.join(POC_ROOT, 'output');

// Verified against developers.openai.com on 2026-10-08 (see docs/poc/voice-ai-poc-results.md).
export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';
export const MINI_REALTIME_MODEL = 'gpt-realtime-2.1-mini';
export const TTS_MODEL = 'gpt-4o-mini-tts';
export const TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
export const VOICES = ['marin', 'cedar', 'coral'] as const;

export const config = {
  apiKey: process.env.OPENAI_API_KEY ?? '',
  model: process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL,
  maxUsd: Number(process.env.POC_MAX_USD ?? '10'),
  port: Number(process.env.POC_PORT ?? '5199'),
};

export const hasApiKey = (): boolean => config.apiKey.trim().length > 0;

export const requireApiKey = (): string => {
  if (!hasApiKey()) {
    throw new Error(
      'OPENAI_API_KEY is not set. Add it to cell-ai-voicebot-backend/.env (never commit it) and re-run.',
    );
  }
  return config.apiKey;
};
