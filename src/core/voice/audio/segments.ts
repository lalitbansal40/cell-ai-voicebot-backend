/**
 * Call recordings for transcription (Phase 14): split the stereo recording (customer
 * left, bot / agent right — `CallRecorder`) and cut each side into speech segments with
 * the energy VAD, so each segment becomes one transcript turn at its real time.
 */
import type { Pcm16 } from './pcm';
import { EnergyVad } from './vad';
import { WavError } from './wav';

export interface StereoRecording {
  rate: number;
  /** Customer. */
  left: Pcm16;
  /** Bot / agent (empty for a mono file). */
  right: Pcm16;
}

/** PCM16 WAV → its two channels (mono → `left` only). */
export const splitStereo = (wav: Uint8Array): StereoRecording => {
  const buf = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new WavError('Not a WAV file');
  let offset = 12;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  let format = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (format !== 1 || bits !== 16 || (channels !== 1 && channels !== 2))
        throw new WavError('Only 16-bit PCM mono / stereo recordings are supported');
      const end = Math.min(buf.length, body + size);
      const samples = Math.floor((end - body) / 2);
      const all = new Int16Array(samples);
      for (let i = 0; i < samples; i += 1) all[i] = buf.readInt16LE(body + i * 2);
      if (channels === 1) return { rate, left: all, right: new Int16Array(0) };
      const frames = Math.floor(samples / 2);
      const left = new Int16Array(frames);
      const right = new Int16Array(frames);
      for (let i = 0; i < frames; i += 1) {
        left[i] = all[i * 2] as number;
        right[i] = all[i * 2 + 1] as number;
      }
      return { rate, left, right };
    }
    offset = body + size + (size % 2);
  }
  throw new WavError('WAV has no data');
};

export interface Segment {
  startMs: number;
  endMs: number;
}

export interface SegmentOptions {
  frameMs?: number;
  /** Segments shorter than this are dropped (clicks, breaths). */
  minMs?: number;
  /** Longer speech is cut into pieces of at most this length. */
  maxMs?: number;
  threshold?: number;
}

/** Speech segments of one channel (energy VAD, 500 ms hangover). */
export const speechSegments = (
  pcm: Pcm16,
  rate: number,
  options: SegmentOptions = {},
): Segment[] => {
  const frameMs = options.frameMs ?? 20;
  const minMs = options.minMs ?? 300;
  const maxMs = options.maxMs ?? 30_000;
  const frame = Math.max(1, Math.round((rate * frameMs) / 1000));
  const vad = new EnergyVad({
    threshold: options.threshold ?? 500,
    startFrames: 2,
    stopFrames: 25,
  });
  const raw: Segment[] = [];
  let start: number | null = null;
  const frames = Math.floor(pcm.length / frame);
  for (let i = 0; i < frames; i += 1) {
    const event = vad.push(pcm.subarray(i * frame, (i + 1) * frame));
    // the VAD reports a start after `startFrames` and a stop after the hangover
    if (event === 'started') start = Math.max(0, (i - 1) * frameMs);
    if (event === 'stopped' && start !== null) {
      raw.push({ startMs: start, endMs: (i - 24) * frameMs });
      start = null;
    }
  }
  if (start !== null) raw.push({ startMs: start, endMs: frames * frameMs });
  const out: Segment[] = [];
  for (const s of raw) {
    if (s.endMs - s.startMs < minMs) continue;
    for (let t = s.startMs; t < s.endMs; t += maxMs)
      out.push({ startMs: t, endMs: Math.min(s.endMs, t + maxMs) });
  }
  return out;
};

/** The samples of a segment. */
export const sliceMs = (pcm: Pcm16, rate: number, s: Segment): Pcm16 =>
  pcm.subarray(Math.floor((s.startMs * rate) / 1000), Math.ceil((s.endMs * rate) / 1000));
