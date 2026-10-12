/** ITU-T G.711 μ-law and A-law (8-bit) ⇄ PCM16. */
import type { Pcm16 } from './pcm';

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export const linearToMulaw = (sample: number): number => {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
};

export const mulawToLinear = (byte: number): number => {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = ((((u & 0x0f) << 3) + MULAW_BIAS) << exponent) - MULAW_BIAS;
  return u & 0x80 ? -magnitude : magnitude;
};

const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

export const linearToAlaw = (sample: number): number => {
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample))) >> 3;
  let mask = 0xd5;
  if (pcm < 0) {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  // a 16-bit sample is at most 4095 after `>> 3`, so a segment always matches
  const seg = ALAW_SEG_END.findIndex((end) => pcm <= end);
  const mantissa = seg < 2 ? (pcm >> 1) & 0x0f : (pcm >> seg) & 0x0f;
  return ((seg << 4) | mantissa) ^ mask;
};

export const alawToLinear = (byte: number): number => {
  const a = byte ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
};

export const encodeMulaw = (pcm: Pcm16): Uint8Array => Uint8Array.from(pcm, linearToMulaw);
export const decodeMulaw = (bytes: Uint8Array): Pcm16 => Int16Array.from(bytes, mulawToLinear);
export const encodeAlaw = (pcm: Pcm16): Uint8Array => Uint8Array.from(pcm, linearToAlaw);
export const decodeAlaw = (bytes: Uint8Array): Pcm16 => Int16Array.from(bytes, alawToLinear);
