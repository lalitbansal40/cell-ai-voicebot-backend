/**
 * Fixed-TTS quality check for `speak` nodes (T0.15 step 9):
 * synthesises sample sentences in several voices → output/tts-check/*.wav.
 *
 *   npm run tts-check -- --voices marin,cedar,coral
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { SAMPLE_RATE_REALTIME, wavFromPcm16 } from './audio.ts';
import { spentUsd } from './budget.ts';
import { OUTPUT_DIR, requireApiKey, VOICES } from './config.ts';
import { synthesize } from './tts.ts';

export const SENTENCES = [
  {
    id: 'hi-amount',
    text: 'नमस्ते ललित जी, आपका ₹5,500 का लोन 120 दिन से बकाया है।',
    instructions: 'Speak politely in Hindi like a bank customer-care agent.',
  },
  {
    id: 'hi-big-amount',
    text: 'आपके खाते में कुल बकाया राशि ₹12,75,000 है।',
    instructions: 'Speak clearly in Hindi.',
  },
  {
    id: 'en-date',
    text: 'Your next EMI of ₹2,750 is due on 15 October 2026.',
    instructions: 'Speak in English with a neutral Indian accent.',
  },
  {
    id: 'hinglish-upi',
    text: 'Aap UPI se payment kar sakte hain, link aapko SMS par bhej diya gaya hai.',
    instructions: 'Speak casual Hinglish.',
  },
  {
    id: 'en-phone',
    text: 'For help, call us on 1800 123 4567, that is one eight zero zero, one two three, four five six seven.',
    instructions: 'Speak clearly and slowly.',
  },
  {
    id: 'hi-dtmf',
    text: 'अगर आपने भुगतान कर दिया है तो 1 दबाइए, बात करने के लिए 2 दबाइए।',
    instructions: 'Speak like an IVR prompt in Hindi.',
  },
];

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const main = async (): Promise<void> => {
  requireApiKey();
  const voices = arg('voices', VOICES.join(',')).split(',');
  const dir = path.join(OUTPUT_DIR, 'tts-check');
  mkdirSync(dir, { recursive: true });
  const before = spentUsd();
  let chars = 0;
  for (const voice of voices) {
    for (const s of SENTENCES) {
      const pcm = await synthesize({ text: s.text, voice, instructions: s.instructions });
      writeFileSync(
        path.join(dir, `${s.id}__${voice}.wav`),
        wavFromPcm16(pcm, SAMPLE_RATE_REALTIME),
      );
      chars += s.text.length;
      console.info(`✓ ${s.id} (${voice})`);
    }
  }
  const usd = spentUsd() - before;
  console.info(
    `TTS check done: ${chars} chars, ≈ $${usd.toFixed(4)} (≈ $${((usd / Math.max(chars, 1)) * 1000).toFixed(4)} per 1k chars, estimate). Files: ${dir}`,
  );
};

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
