/** Tiny deterministic WAV / MP3 writers for fixtures and samples (no dependencies). */

/** PCM16 sine tone (or μ-law silence) as a WAV file. */
export const makeWav = (opts: {
  sampleRate: number;
  seconds: number;
  format?: 'pcm16' | 'ulaw';
  channels?: number;
  /** Declared data size override (fake long headers in tests). */
  declaredDataBytes?: number;
}): Buffer => {
  const channels = opts.channels ?? 1;
  const ulaw = opts.format === 'ulaw';
  const bytesPerSample = ulaw ? 1 : 2;
  const frames = Math.round(opts.sampleRate * opts.seconds);
  const data = Buffer.alloc(frames * channels * bytesPerSample);
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const at = (i * channels + c) * bytesPerSample;
      if (ulaw)
        data[at] = 0xff; // μ-law silence
      else
        data.writeInt16LE(
          Math.round(Math.sin((2 * Math.PI * 440 * i) / opts.sampleRate) * 8000),
          at,
        );
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(ulaw ? 7 : 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(opts.sampleRate, 24);
  header.writeUInt32LE(opts.sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(opts.declaredDataBytes ?? data.length, 40);
  return Buffer.concat([header, data]);
};

/** MPEG-1 Layer III, 44.1 kHz stereo frame of `kbps` (silent body). */
const mp3Frame = (kbps: number, bitrateIndex: number, mono = false): Buffer => {
  const length = Math.floor((144 * kbps * 1000) / 44_100);
  const frame = Buffer.alloc(length);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1, Layer III, no CRC
  frame[2] = (bitrateIndex << 4) | (0 << 2); // 44.1 kHz, no padding
  frame[3] = mono ? 0xc0 : 0x00;
  return frame;
};

/** Constant bitrate MP3 of `frames` frames (optionally behind an ID3v2 tag). */
export const makeCbrMp3 = (frames: number, id3 = false): Buffer => {
  const body = Buffer.concat(Array.from({ length: frames }, () => mp3Frame(128, 9)));
  if (!id3) return body;
  const tagBody = Buffer.alloc(20, 0x20);
  const tag = Buffer.alloc(10);
  tag.write('ID3', 0, 'ascii');
  tag[3] = 3;
  tag[9] = tagBody.length; // syncsafe size (< 128)
  return Buffer.concat([tag, tagBody, body]);
};

/** VBR MP3 whose first frame carries a Xing header claiming `declaredFrames`. */
export const makeXingMp3 = (declaredFrames: number, realFrames = 5): Buffer => {
  const first = mp3Frame(128, 9);
  const xing = 4 + 32; // header + stereo side info
  first.write('Xing', xing, 'ascii');
  first.writeUInt32BE(1, xing + 4); // frames field present
  first.writeUInt32BE(declaredFrames, xing + 8);
  return Buffer.concat([first, ...Array.from({ length: realFrames }, () => mp3Frame(128, 9))]);
};

/** MP3 whose first frame carries a VBRI header (Fraunhofer) claiming `declaredFrames`. */
export const makeVbriMp3 = (declaredFrames: number): Buffer => {
  const first = mp3Frame(128, 9);
  first.write('VBRI', 36, 'ascii');
  first.writeUInt32BE(declaredFrames, 50);
  return Buffer.concat([first, mp3Frame(128, 9), mp3Frame(128, 9)]);
};
