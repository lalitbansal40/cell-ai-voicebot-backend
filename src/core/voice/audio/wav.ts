import { open, type FileHandle } from 'node:fs/promises';

import { decodeAlaw, decodeMulaw } from './g711';
import { fromBytes, toBytes, type Pcm16 } from './pcm';

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WavError';
  }
}

export interface WavAudio {
  rate: number;
  channels: number;
  /** Mono mixdown (channels averaged). */
  pcm: Pcm16;
}

const header = (dataBytes: number, rate: number, channels: number): Buffer => {
  const blockAlign = channels * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
};

/** In-memory PCM16 WAV (interleaved when `channels > 1`). */
export const wavBuffer = (samples: Pcm16, rate: number, channels = 1): Buffer =>
  Buffer.concat([header(samples.length * 2, rate, channels), toBytes(samples)]);

const mixdown = (interleaved: Pcm16, channels: number): Pcm16 => {
  if (channels === 1) return interleaved;
  const out = new Int16Array(Math.floor(interleaved.length / channels));
  for (let i = 0; i < out.length; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += interleaved[i * channels + c] as number;
    out[i] = Math.round(sum / channels);
  }
  return out;
};

/** Reads PCM16 / μ-law / A-law WAV (mono or stereo) into a mono PCM16 clip. */
export const readWav = (wav: Uint8Array): WavAudio => {
  const buf = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new WavError('Not a WAV file');
  }
  let offset = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, Math.min(buf.length, offset + 8 + size));
    if (id === 'fmt ' && body.length >= 16) {
      fmt = {
        format: body.readUInt16LE(0),
        channels: body.readUInt16LE(2),
        rate: body.readUInt32LE(4),
        bits: body.readUInt16LE(14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new WavError('WAV data before its format');
      if (fmt.channels < 1 || fmt.channels > 2) throw new WavError('Only mono or stereo WAV');
      let samples: Pcm16;
      if (fmt.format === 1 && fmt.bits === 16) samples = fromBytes(body);
      else if (fmt.format === 7 && fmt.bits === 8) samples = decodeMulaw(body);
      else if (fmt.format === 6 && fmt.bits === 8) samples = decodeAlaw(body);
      else throw new WavError(`Unsupported WAV encoding ${String(fmt.format)}/${String(fmt.bits)}`);
      return { rate: fmt.rate, channels: fmt.channels, pcm: mixdown(samples, fmt.channels) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new WavError('WAV data not found');
};

/** Streams PCM16 into a WAV file; `close()` patches the sizes in the header. */
export class WavFileWriter {
  private bytes = 0;

  private constructor(
    private readonly handle: FileHandle,
    readonly rate: number,
    readonly channels: number,
  ) {}

  static async create(path: string, rate: number, channels: number): Promise<WavFileWriter> {
    const handle = await open(path, 'w');
    await handle.write(header(0, rate, channels), 0, 44, 0);
    return new WavFileWriter(handle, rate, channels);
  }

  get dataBytes(): number {
    return this.bytes;
  }

  async write(samples: Pcm16): Promise<void> {
    const data = toBytes(samples);
    await this.handle.write(data, 0, data.length, 44 + this.bytes);
    this.bytes += data.length;
  }

  async close(): Promise<{ dataBytes: number; durationMs: number }> {
    await this.handle.write(header(this.bytes, this.rate, this.channels), 0, 44, 0);
    await this.handle.close();
    return {
      dataBytes: this.bytes,
      durationMs: Math.round((this.bytes / (2 * this.channels * this.rate)) * 1000),
    };
  }
}
