import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { bufferToPcm16, pcm16ToBuffer, SAMPLE_RATE_REALTIME, type Pcm16 } from './audio.ts';
import { recordSpend } from './budget.ts';
import { OUTPUT_DIR, requireApiKey, TTS_MODEL } from './config.ts';
import { TTS_PRICE } from './pricing.ts';

const CACHE_DIR = path.join(OUTPUT_DIR, 'tts-cache');

export interface TtsRequest {
  text: string;
  voice: string;
  /** Delivery instructions, e.g. "Speak angrily, loudly, in Hindi". */
  instructions?: string;
}

/** Rough TTS cost estimate: text tokens ≈ chars/4; audio tokens unknown → estimated from duration. */
const estimateCostUsd = (text: string, audioMs: number): number => {
  const textTokens = Math.ceil(text.length / 4);
  const audioTokens = Math.ceil((audioMs / 1000) * 20); // conservative estimate, refined in report
  return (textTokens * TTS_PRICE.textIn + audioTokens * TTS_PRICE.audioOut) / 1_000_000;
};

/**
 * Synthesises customer speech as PCM16 @ 24 kHz (OpenAI `response_format: "pcm"`).
 * Cached on disk by request hash so repeated runs cost nothing.
 */
export const synthesize = async (req: TtsRequest): Promise<Pcm16> => {
  const key = createHash('sha256')
    .update(JSON.stringify([TTS_MODEL, req]))
    .digest('hex')
    .slice(0, 24);
  const file = path.join(CACHE_DIR, `${key}.pcm`);
  if (existsSync(file)) return bufferToPcm16(readFileSync(file));

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireApiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: req.voice,
      input: req.text,
      instructions: req.instructions,
      response_format: 'pcm',
    }),
  });
  if (!res.ok) throw new Error(`TTS failed: HTTP ${res.status} ${await res.text()}`);
  const pcm = bufferToPcm16(Buffer.from(await res.arrayBuffer()));
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, pcm16ToBuffer(pcm));
  recordSpend(
    `tts:${req.voice}`,
    estimateCostUsd(req.text, (pcm.length / SAMPLE_RATE_REALTIME) * 1000),
  );
  return pcm;
};
