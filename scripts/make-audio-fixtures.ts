/**
 * Generates the audio test fixtures (`tests/fixtures/audio/`) and the sample
 * prompt `docs/samples/audio/welcome.wav`: `npm run fixtures:audio`.
 * Deterministic — committed byte-exact.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { makeCbrMp3, makeVbriMp3, makeWav, makeXingMp3 } from './lib/audio';

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
console.info(
  `Wrote ${String(Object.keys(files).length)} fixtures and docs/samples/audio/welcome.wav`,
);
