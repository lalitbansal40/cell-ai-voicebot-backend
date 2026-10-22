import { corrupt } from './ebml';

/** Samples (48 kHz) of one Opus frame by TOC config (RFC 6716 §3.1). */
const frameSamples = (config: number): number => {
  if (config < 12) return [480, 960, 1920, 2880][config % 4] as number; // SILK 10 / 20 / 40 / 60 ms
  if (config < 16) return [480, 960][config % 2] as number; // Hybrid 10 / 20 ms
  return [120, 240, 480, 960][config % 4] as number; // CELT 2.5 / 5 / 10 / 20 ms
};

/** Samples (48 kHz) in one Opus packet; max 120 ms (5760). */
export const opusPacketSamples = (packet: Buffer): number => {
  const toc = packet[0];
  if (toc === undefined) throw corrupt('empty audio packet');
  const per = frameSamples(toc >> 3);
  const code = toc & 0x03;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else {
    const count = packet[1];
    if (count === undefined) throw corrupt('bad audio packet');
    frames = count & 0x3f;
  }
  const samples = per * frames;
  if (frames < 1 || samples > 5760) throw corrupt('bad audio packet');
  return samples;
};

/** Channel count signalled by the TOC stereo bit (s). */
export const opusPacketStereo = (packet: Buffer): boolean => ((packet[0] ?? 0) & 0x04) !== 0;
