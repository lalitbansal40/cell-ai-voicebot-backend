/**
 * Minimal WAV / MP3 probes (PHASE_6_PROMPT §1 Audio probe) — enough to accept
 * a prompt file and know its length. No decoding, no dependencies.
 */

export interface AudioProbe {
  format: 'wav' | 'mp3';
  durationMs: number;
  sampleRate: number;
  channels: number;
}

/** PCM, A-law and μ-law (what telephony can play after Phase 7 / 13 conversion). */
const WAV_FORMATS = new Set([1, 6, 7]);

export const probeWav = (buf: Buffer): AudioProbe | null => {
  if (
    buf.length < 12 ||
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    return null;
  }
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; byteRate: number } | null = null;
  let dataBytes: number | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
      };
    } else if (id === 'data') {
      // streaming writers leave the size empty / max → use what is there
      dataBytes = size === 0 || size === 0xffffffff ? buf.length - body : size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataBytes === null) return null;
  if (
    !WAV_FORMATS.has(fmt.format) ||
    fmt.channels < 1 ||
    fmt.channels > 2 ||
    fmt.sampleRate < 8000 ||
    fmt.sampleRate > 48_000 ||
    fmt.byteRate === 0
  ) {
    return null;
  }
  return {
    format: 'wav',
    durationMs: Math.round((dataBytes / fmt.byteRate) * 1000),
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
  };
};

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000], // MPEG 1
  2: [22_050, 24_000, 16_000], // MPEG 2
  0: [11_025, 12_000, 8000], // MPEG 2.5
};

interface Mp3Frame {
  version: number;
  bitrate: number;
  sampleRate: number;
  channels: number;
  samples: number;
  length: number;
}

/** Layer III frame header at `at`, or `null`. */
export const readMp3Frame = (buf: Buffer, at: number): Mp3Frame | null => {
  if (at + 4 > buf.length) return null;
  const b1 = buf[at + 1] ?? 0;
  const b2 = buf[at + 2] ?? 0;
  const b3 = buf[at + 3] ?? 0;
  if (buf[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  const layer = (b1 >> 1) & 3;
  if (version === 1 || layer !== 1) return null;
  const bitrateKbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[b2 >> 4];
  const sampleRate = SAMPLE_RATES[version]?.[(b2 >> 2) & 3];
  if (!bitrateKbps || !sampleRate) return null;
  const padding = (b2 >> 1) & 1;
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor(((samples / 8) * bitrateKbps * 1000) / sampleRate) + padding;
  return {
    version,
    bitrate: bitrateKbps * 1000,
    sampleRate,
    channels: b3 >> 6 === 3 ? 1 : 2,
    samples,
    length,
  };
};

const SCAN_LIMIT = 64 * 1024;

export const probeMp3 = (buf: Buffer): AudioProbe | null => {
  let start = 0;
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const size =
      ((buf[6] ?? 0) << 21) | ((buf[7] ?? 0) << 14) | ((buf[8] ?? 0) << 7) | (buf[9] ?? 0);
    start = 10 + size + (((buf[5] ?? 0) & 0x10) !== 0 ? 10 : 0);
  }
  let at = start;
  let frame: Mp3Frame | null = null;
  for (; at < Math.min(buf.length, start + SCAN_LIMIT); at += 1) {
    frame = readMp3Frame(buf, at);
    // a real stream has another frame right after the first (when the file is that long)
    if (frame && (at + frame.length + 4 > buf.length || readMp3Frame(buf, at + frame.length)))
      break;
    frame = null;
  }
  if (!frame) return null;
  const mono = frame.channels === 1;
  const sideInfo = frame.version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
  const xing = at + 4 + sideInfo;
  let frames: number | null = null;
  const tag = buf.toString('ascii', xing, xing + 4);
  if (
    (tag === 'Xing' || tag === 'Info') &&
    xing + 12 <= buf.length &&
    (buf.readUInt32BE(xing + 4) & 1) === 1
  ) {
    frames = buf.readUInt32BE(xing + 8);
  } else if (buf.toString('ascii', at + 36, at + 40) === 'VBRI' && at + 54 <= buf.length) {
    frames = buf.readUInt32BE(at + 50);
  }
  const durationMs =
    frames !== null && frames > 0
      ? Math.round(((frames * frame.samples) / frame.sampleRate) * 1000)
      : Math.round((((buf.length - at) * 8) / frame.bitrate) * 1000);
  return { format: 'mp3', durationMs, sampleRate: frame.sampleRate, channels: frame.channels };
};

/** WAV or MP3 (by content, never by file name) — `null` when neither. */
export const probeAudio = (buf: Buffer): AudioProbe | null => probeWav(buf) ?? probeMp3(buf);
