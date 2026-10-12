import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { LocalStorage, signingKey } from '../../storage';

import {
  AudioDecodeError,
  decodeAudioFile,
  decodedAudio,
  decodedCacheKey,
  DECODE_RATE,
} from './decode';
import { encodeAlaw, encodeMulaw } from './g711';
import { tone } from './pcm';
import { StereoMixer } from './recorder';
import { readWav, wavBuffer, WavError, WavFileWriter } from './wav';

const dir = mkdtempSync(path.join(tmpdir(), 'cav-audio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const fixture = (name: string) =>
  readFileSync(path.join(__dirname, '../../../../tests/fixtures/audio', name));

const rawWav = (format: number, bits: number, channels: number, data: Buffer, rate = 8000) => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(format, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE((rate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
};

describe('WAV', () => {
  it('writes and reads PCM16 mono / stereo (stereo mixed down)', () => {
    const mono = readWav(wavBuffer(Int16Array.from([1, 2, 3]), 8000));
    expect(mono).toMatchObject({ rate: 8000, channels: 1 });
    expect(Array.from(mono.pcm)).toEqual([1, 2, 3]);
    const stereo = readWav(wavBuffer(Int16Array.from([10, 20, 30, 41]), 16000, 2));
    expect(Array.from(stereo.pcm)).toEqual([15, 36]);
  });

  it('reads μ-law / A-law and the Phase 6 fixtures; refuses broken files', () => {
    const pcm = Int16Array.from([0, 1000, -1000]);
    expect(readWav(rawWav(7, 8, 1, Buffer.from(encodeMulaw(pcm)))).pcm).toHaveLength(3);
    expect(readWav(rawWav(6, 8, 1, Buffer.from(encodeAlaw(pcm)))).pcm).toHaveLength(3);
    expect(readWav(fixture('long-header.wav')).rate).toBeGreaterThan(0);
    expect(readWav(fixture('stereo-48k.wav')).channels).toBe(2);
    expect(() => readWav(Buffer.from('hello world!'))).toThrow(WavError);
    expect(() => readWav(Buffer.from('RI'))).toThrow('Not a WAV file');
    expect(() => readWav(rawWav(3, 32, 1, Buffer.alloc(8)))).toThrow(
      'Unsupported WAV encoding 3/32',
    );
    expect(() => readWav(rawWav(1, 16, 3, Buffer.alloc(12)))).toThrow('Only mono or stereo WAV');
    const noData = rawWav(1, 16, 1, Buffer.alloc(0)).subarray(0, 36);
    expect(() => readWav(noData)).toThrow('WAV data not found');
    const dataFirst = Buffer.concat([
      Buffer.from('RIFF\0\0\0\0WAVE', 'ascii'),
      Buffer.from('data', 'ascii'),
      Buffer.from([2, 0, 0, 0, 1, 0]),
    ]);
    expect(() => readWav(dataFirst)).toThrow('WAV data before its format');
    // odd-sized chunk padding is skipped
    const odd = Buffer.concat([
      Buffer.from('RIFF\0\0\0\0WAVE', 'ascii'),
      Buffer.from('junk', 'ascii'),
      Buffer.from([1, 0, 0, 0, 9, 0]),
      rawWav(1, 16, 1, Buffer.from([5, 0])).subarray(12),
    ]);
    expect(Array.from(readWav(odd).pcm)).toEqual([5]);
  });

  it('streams a stereo file and patches the header on close', async () => {
    const file = path.join(dir, 'stream.wav');
    const writer = await WavFileWriter.create(file, 8000, 2);
    await writer.write(new Int16Array(320));
    await writer.write(Int16Array.from([7, 8]));
    expect(writer.dataBytes).toBe(644);
    expect(await writer.close()).toEqual({ dataBytes: 644, durationMs: 20 });
    const back = readWav(readFileSync(file));
    expect(back).toMatchObject({ rate: 8000, channels: 2 });
    expect(back.pcm).toHaveLength(161);
  });
});

describe('StereoMixer', () => {
  it('emits 20 ms of interleaved stereo per tick; missing audio is silence; backlog is capped', () => {
    const mixer = new StereoMixer(24000, 8000);
    mixer.addCustomer(tone(20, 24000, { amplitude: 9000, fadeMs: 0, hz: 300 }));
    mixer.addCustomer(tone(20, 24000, { amplitude: 9000, fadeMs: 0, hz: 300 }));
    const out = mixer.tick();
    expect(out).toHaveLength(320);
    const left = out.filter((_v, i) => i % 2 === 0);
    const right = out.filter((_v, i) => i % 2 === 1);
    expect(left.some((v) => v !== 0)).toBe(true);
    expect(right.every((v) => v === 0)).toBe(true);
    for (let i = 0; i < 80; i += 1) mixer.addBot(tone(20, 24000, { fadeMs: 0 }));
    let bot = 0;
    for (let i = 0; i < 80; i += 1)
      bot += mixer.tick().filter((_v, j) => j % 2 === 1 && _v !== 0).length;
    expect(bot).toBeLessThanOrEqual(8000); // ≤ 1 s kept
    expect(bot).toBeGreaterThan(7000);
  });
});

describe('decode', () => {
  it('WAV and MP3 become 24 kHz mono; broken files are AudioDecodeError', async () => {
    const wav = await decodeAudioFile(fixture('tone-8k-mono.wav'), 'wav');
    expect(wav.length).toBeGreaterThan(0);
    expect(DECODE_RATE).toBe(24000);
    const mp3 = await decodeAudioFile(fixture('cbr-128k.mp3'), 'mp3');
    expect(mp3.length).toBeGreaterThan(1000);
    await expect(decodeAudioFile(Buffer.from('nope'), 'wav')).rejects.toThrow(AudioDecodeError);
    await expect(decodeAudioFile(fixture('not-audio.mp3'), 'mp3')).rejects.toThrow(
      'No MP3 audio found',
    );
  });

  it('decodes a library file once and serves the stored copy afterwards', async () => {
    const storage = new LocalStorage(
      dir,
      'http://localhost:5100',
      signingKey({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined }),
    );
    const audio = {
      id: 'a1',
      accountId: '64b000000000000000000001',
      fileKey: 'accounts/64b000000000000000000001/flow-audio/a1.wav',
      format: 'wav' as const,
    };
    await storage.put(audio.fileKey, fixture('tone-8k-mono.wav'), { contentType: 'audio/wav' });
    const first = await decodedAudio(storage, audio);
    expect(await storage.exists(decodedCacheKey(audio))).toBe(true);
    await storage.delete(audio.fileKey);
    const second = await decodedAudio(storage, audio);
    expect(Array.from(second)).toEqual(Array.from(first));
  });
});
