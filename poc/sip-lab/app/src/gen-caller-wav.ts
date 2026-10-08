/** Generates generated/caller.wav — 4 s of "speech-like" tones, G.711 μ-law 8 kHz (SIPp streams it as RTP). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { linearToMulaw, mulawWav } from './rtp.ts';

const out = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'generated',
  'caller.wav',
);
const rate = 8000;
const segments = [300, 450, 600, 400, 750, 500, 350, 650]; // Hz, 0.5 s each
const bytes = new Uint8Array(segments.length * rate * 0.5);
segments.forEach((hz, s) => {
  for (let i = 0; i < rate * 0.5; i += 1) {
    const envelope = Math.sin((Math.PI * i) / (rate * 0.5)); // fade in/out like syllables
    bytes[s * rate * 0.5 + i] = linearToMulaw(
      9000 * envelope * Math.sin((2 * Math.PI * hz * i) / rate),
    );
  }
});
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, mulawWav(bytes));
console.info(`wrote ${out} (${bytes.length / rate}s μ-law 8 kHz)`);
