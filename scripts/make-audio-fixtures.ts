/**
 * Generates the audio test fixtures (`tests/fixtures/audio/`), the sample
 * prompt `docs/samples/audio/welcome.wav`, `customer-silence.wav` (Chromium's
 * fake mic in the Playwright call tests) and the WhatsApp call tones (Phase 12):
 * `customer-tone.wav` (440 Hz, 3 s — the fake WhatsApp user) and `agent-tone.wav`
 * (1 kHz, 30 s — the agent's fake mic): `npm run fixtures:audio`.
 * Deterministic — committed byte-exact.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { tone } from '../src/core/voice/audio/pcm';
import { wavBuffer } from '../src/core/voice/audio/wav';

import { makeCbrMp3, makeVbriMp3, makeWav, makeXingMp3 } from './lib/audio';

/** 30 s of very quiet noise, 24 kHz mono PCM16 (fixed seed, below the VAD threshold). */
const customerSilence = (): Buffer => {
  const samples = new Int16Array(24_000 * 30);
  let seed = 0x2545f491;
  for (let i = 0; i < samples.length; i += 1) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    samples[i] = ((seed >>> 16) % 41) - 20; // ±20 of 32767
  }
  return wavBuffer(samples, 24_000);
};

const FIXTURES = path.resolve(__dirname, '../tests/fixtures/audio');
const SAMPLES = path.resolve(__dirname, '../docs/samples/audio');

const files: Record<string, Buffer> = {
  'tone-8k-mono.wav': makeWav({ sampleRate: 8000, seconds: 1 }),
  'ulaw-16k.wav': makeWav({ sampleRate: 16_000, seconds: 0.5, format: 'ulaw' }),
  'stereo-48k.wav': makeWav({ sampleRate: 48_000, seconds: 0.25, channels: 2 }),
  'long-header.wav': makeWav({ sampleRate: 8000, seconds: 0.1, declaredDataBytes: 8000 * 2 * 130 }),
  'cbr-128k.mp3': makeCbrMp3(38),
  'id3-cbr.mp3': makeCbrMp3(10, true),
  'vbr-xing.mp3': makeXingMp3(100),
  'vbri.mp3': makeVbriMp3(50),
  'not-audio.mp3': Buffer.from('This is a text file pretending to be an MP3.\n'),
};

mkdirSync(FIXTURES, { recursive: true });
for (const [name, data] of Object.entries(files)) writeFileSync(path.join(FIXTURES, name), data);
mkdirSync(SAMPLES, { recursive: true });
writeFileSync(path.join(SAMPLES, 'welcome.wav'), makeWav({ sampleRate: 8000, seconds: 2 }));
writeFileSync(path.join(SAMPLES, 'customer-silence.wav'), customerSilence());
// WhatsApp calls: distinct tones each way so "heard" checks can tell the sides apart
writeFileSync(
  path.join(SAMPLES, 'customer-tone.wav'),
  wavBuffer(tone(3_000, 24_000, { hz: 440, amplitude: 8_000 }), 24_000),
);
writeFileSync(
  path.join(SAMPLES, 'agent-tone.wav'),
  wavBuffer(tone(30_000, 24_000, { hz: 1_000, amplitude: 8_000 }), 24_000),
);
console.info(
  `Wrote ${String(Object.keys(files).length)} fixtures and docs/samples/audio/{welcome,customer-silence,customer-tone,agent-tone}.wav`,
);
