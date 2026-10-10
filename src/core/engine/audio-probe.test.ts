import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { probeAudio, probeMp3, probeWav, readMp3Frame } from './audio-probe';

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, '../../../tests/fixtures/audio', name));

describe('audio probe', () => {
  it.each([
    ['tone-8k-mono.wav', { format: 'wav', durationMs: 1000, sampleRate: 8000, channels: 1 }],
    ['ulaw-16k.wav', { format: 'wav', durationMs: 500, sampleRate: 16_000, channels: 1 }],
    ['stereo-48k.wav', { format: 'wav', durationMs: 250, sampleRate: 48_000, channels: 2 }],
    ['long-header.wav', { format: 'wav', durationMs: 130_000, sampleRate: 8000, channels: 1 }],
    ['cbr-128k.mp3', { format: 'mp3', durationMs: 990, sampleRate: 44_100, channels: 2 }],
    ['id3-cbr.mp3', { format: 'mp3', durationMs: 261, sampleRate: 44_100, channels: 2 }],
    ['vbr-xing.mp3', { format: 'mp3', durationMs: 2612, sampleRate: 44_100, channels: 2 }],
    ['vbri.mp3', { format: 'mp3', durationMs: 1306, sampleRate: 44_100, channels: 2 }],
  ])('%s', (name, expected) => {
    expect(probeAudio(fixture(name))).toEqual(expected);
  });

  it('refuses text, truncated and unsupported files', () => {
    expect(probeAudio(fixture('not-audio.mp3'))).toBeNull();
    expect(probeAudio(Buffer.alloc(0))).toBeNull();
    const wav = fixture('tone-8k-mono.wav');
    expect(probeWav(wav.subarray(0, 30))).toBeNull(); // no fmt / data
    const float = Buffer.from(wav);
    float.writeUInt16LE(3, 20); // IEEE float
    expect(probeWav(float)).toBeNull();
    const lowRate = Buffer.from(wav);
    lowRate.writeUInt32LE(4000, 24);
    expect(probeWav(lowRate)).toBeNull();
    const zeroRate = Buffer.from(wav);
    zeroRate.writeUInt32LE(0, 28);
    expect(probeWav(zeroRate)).toBeNull();
    const streaming = Buffer.from(wav);
    streaming.writeUInt32LE(0xffffffff, 40);
    expect(probeWav(streaming)?.durationMs).toBe(1000);
  });

  it('skips odd-sized chunks before fmt / data', () => {
    const wav = fixture('tone-8k-mono.wav');
    const extra = Buffer.alloc(8 + 3 + 1);
    extra.write('LIST', 0, 'ascii');
    extra.writeUInt32LE(3, 4);
    const withChunk = Buffer.concat([wav.subarray(0, 12), extra, wav.subarray(12)]);
    expect(probeWav(withChunk)?.durationMs).toBe(1000);
  });

  it('reads MP3 frame headers (MPEG 1 / 2 / 2.5, mono) and rejects bad ones', () => {
    const header = (b1: number, b2: number, b3 = 0) =>
      Buffer.from([0xff, b1, b2, b3, ...Array<number>(600).fill(0)]);
    expect(readMp3Frame(header(0xfb, 0x90), 0)).toMatchObject({
      version: 3,
      bitrate: 128_000,
      sampleRate: 44_100,
      samples: 1152,
      length: 417,
    });
    expect(readMp3Frame(header(0xf3, 0x80, 0xc0), 0)).toMatchObject({
      version: 2,
      sampleRate: 22_050,
      channels: 1,
      samples: 576,
    });
    expect(readMp3Frame(header(0xe3, 0x88), 0)).toMatchObject({ version: 0, sampleRate: 8000 });
    expect(readMp3Frame(header(0xeb, 0x90), 0)).toBeNull(); // reserved version
    expect(readMp3Frame(header(0xfd, 0x90), 0)).toBeNull(); // layer II
    expect(readMp3Frame(header(0xfb, 0x00), 0)).toBeNull(); // free bitrate
    expect(readMp3Frame(header(0xfb, 0x9c), 0)).toBeNull(); // reserved sample rate
    expect(readMp3Frame(Buffer.from([0xff]), 0)).toBeNull();
    // a single lonely frame header with junk after it is not a stream
    const lonely = Buffer.concat([header(0xfb, 0x90).subarray(0, 417), Buffer.alloc(500, 0x41)]);
    expect(probeMp3(lonely)).toBeNull();
    // a mono MPEG-2 frame alone (file ends) is accepted, CBR duration
    const mono = Buffer.from([0xff, 0xf3, 0x80, 0xc0, ...Array<number>(200).fill(0)]);
    expect(probeMp3(mono)).toMatchObject({ format: 'mp3', channels: 1, sampleRate: 22_050 });
  });
});
