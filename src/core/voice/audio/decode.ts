import type { Readable } from 'node:stream';

import { MPEGDecoder } from 'mpg123-decoder';

import type { StorageProvider } from '../../storage';
import { storageKey } from '../../storage';

import { clamp16, fromBytes, toBytes, type Pcm16 } from './pcm';
import { Resampler } from './resample';
import { readWav } from './wav';

export const DECODE_RATE = 24_000;

export class AudioDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioDecodeError';
  }
}

const decodeMp3 = async (bytes: Uint8Array): Promise<{ rate: number; pcm: Pcm16 }> => {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, samplesDecoded, sampleRate } = decoder.decode(bytes);
    if (samplesDecoded === 0 || channelData.length === 0) {
      throw new AudioDecodeError('No MP3 audio found');
    }
    const pcm = new Int16Array(samplesDecoded);
    for (let i = 0; i < samplesDecoded; i += 1) {
      let sum = 0;
      for (const channel of channelData) sum += channel[i] as number;
      pcm[i] = clamp16((sum / channelData.length) * 32767);
    }
    return { rate: sampleRate, pcm };
  } finally {
    decoder.free();
  }
};

/** WAV (PCM16 / μ-law / A-law) or MP3 → mono PCM16 at 24 kHz. */
export const decodeAudioFile = async (bytes: Uint8Array, format: 'wav' | 'mp3'): Promise<Pcm16> => {
  let decoded: { rate: number; pcm: Pcm16 };
  if (format === 'wav') {
    try {
      decoded = readWav(bytes);
    } catch (err) {
      throw new AudioDecodeError((err as Error).message);
    }
  } else {
    decoded = await decodeMp3(bytes);
  }
  return Resampler.convert(decoded.pcm, decoded.rate, DECODE_RATE);
};

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
};

export interface DecodableAudio {
  id: string;
  accountId: string;
  fileKey: string;
  format: 'wav' | 'mp3';
}

export const decodedCacheKey = (audio: Pick<DecodableAudio, 'id' | 'accountId'>): string =>
  storageKey({ accountId: audio.accountId, area: 'flow-audio-cache', id: audio.id, ext: 'pcm' });

/** Decodes a library file once and keeps the 24 kHz PCM next to it in storage. */
export const decodedAudio = async (
  storage: StorageProvider,
  audio: DecodableAudio,
): Promise<Pcm16> => {
  const cacheKey = decodedCacheKey(audio);
  if (await storage.exists(cacheKey)) return fromBytes(await readAll(await storage.get(cacheKey)));
  const pcm = await decodeAudioFile(await readAll(await storage.get(audio.fileKey)), audio.format);
  await storage.put(cacheKey, toBytes(pcm), { contentType: 'application/octet-stream' });
  return pcm;
};
