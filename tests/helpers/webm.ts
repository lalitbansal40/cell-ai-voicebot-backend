/**
 * Test-only EBML / WebM writer: builds browser-like voice recordings (Opus in WebM)
 * with every variation the remuxer must handle. No real audio — Opus packets are
 * silent CELT frames (TOC + filler), which is enough for container tests.
 */

const idBytes = (id: number): Buffer => {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(out);
};

/** Minimal EBML size vint (marker included). */
export const sizeVint = (n: number): Buffer => {
  for (let len = 1; len <= 8; len += 1) {
    if (n < 2 ** (7 * len) - 1) {
      const b = Buffer.alloc(len);
      let v = n;
      for (let i = len - 1; i >= 0; i -= 1) {
        b[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      b[0] = (b[0] as number) | (0x80 >> (len - 1));
      return b;
    }
  }
  throw new Error('size too large');
};

/** EBML-lacing signed vint: the shortest length whose range holds `n` (bias 2^(7L-1) - 1). */
export const signedVint = (n: number): Buffer => {
  for (let len = 1; len <= 8; len += 1) {
    const bias = 2 ** (7 * len - 1) - 1;
    if (Math.abs(n) <= bias - 1) {
      const raw = n + bias;
      const b = Buffer.alloc(len);
      let v = raw;
      for (let i = len - 1; i >= 0; i -= 1) {
        b[i] = v & 0xff;
        v = Math.floor(v / 256);
      }
      b[0] = (b[0] as number) | (0x80 >> (len - 1));
      return b;
    }
  }
  throw new Error('difference too large');
};

const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

export const el = (
  id: number,
  payload: Buffer | Buffer[] = [],
  opts: { unknownSize?: boolean; size?: number } = {},
): Buffer => {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.concat(payload);
  const size = opts.unknownSize ? UNKNOWN : sizeVint(opts.size ?? data.length);
  return Buffer.concat([idBytes(id), size, data]);
};

const uint = (n: number): Buffer => {
  if (n === 0) return Buffer.from([0]);
  const out: number[] = [];
  let v = n;
  while (v > 0) {
    out.unshift(v & 0xff);
    v = Math.floor(v / 256);
  }
  return Buffer.from(out);
};

export const opusHeadBytes = (channels = 1, preSkip = 312): Buffer => {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b[8] = 1;
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48000, 12);
  return b;
};

/** A 20 ms mono CELT packet (TOC config 31, code 0) + filler. */
export const silentPacket = (bytes = 3): Buffer => {
  const b = Buffer.alloc(bytes, 0xfe);
  b[0] = 0xf8;
  return b;
};

/** 120 ms packet (TOC config 31, code 3, 6 frames). */
export const longPacket = (): Buffer => Buffer.from([0xfb, 0x06, 0xfe, 0xfe]);

export type Lacing = 'none' | 'xiph' | 'ebml' | 'fixed';

export interface WebmOptions {
  docType?: string;
  codec?: string;
  trackType?: number;
  channels?: number | null;
  codecPrivate?: Buffer | null;
  codecDelayNs?: number | null;
  tracks?: number;
  packets?: Buffer[];
  perCluster?: number;
  unknownSizes?: boolean;
  blockGroup?: boolean;
  lacing?: Lacing;
  framesPerBlock?: number;
  /** Put the Tracks element after the first cluster. */
  tracksLast?: boolean;
}

const lacingBits: Record<Lacing, number> = { none: 0, xiph: 1, fixed: 2, ebml: 3 };

const block = (frames: Buffer[], lacing: Lacing, simple: boolean, timecode: number): Buffer => {
  const head = Buffer.from([
    0x81,
    (timecode >> 8) & 0xff,
    timecode & 0xff,
    (simple ? 0x80 : 0) | (lacingBits[lacing] << 1),
  ]);
  if (lacing === 'none') return Buffer.concat([head, frames[0] as Buffer]);
  const sizes: Buffer[] = [Buffer.from([frames.length - 1])];
  if (lacing === 'xiph') {
    for (const f of frames.slice(0, -1)) {
      let n = f.length;
      const bytes: number[] = [];
      while (n >= 255) {
        bytes.push(255);
        n -= 255;
      }
      bytes.push(n);
      sizes.push(Buffer.from(bytes));
    }
  } else if (lacing === 'ebml') {
    sizes.push(sizeVint((frames[0] as Buffer).length));
    for (let i = 1; i < frames.length - 1; i += 1) {
      const diff = (frames[i] as Buffer).length - (frames[i - 1] as Buffer).length;
      sizes.push(signedVint(diff));
    }
  }
  return Buffer.concat([head, ...sizes, ...frames]);
};

/** A WebM voice recording (defaults = Chrome: unknown-size segment / clusters, SimpleBlocks). */
export const buildWebm = (o: WebmOptions = {}): Buffer => {
  const packets = o.packets ?? Array.from({ length: 100 }, () => silentPacket());
  const lacing = o.lacing ?? 'none';
  const perBlock = lacing === 'none' ? 1 : (o.framesPerBlock ?? 4);
  const perCluster = o.perCluster ?? 25;
  const header = el(0x1a45dfa3, [
    el(0x4286, uint(1)),
    el(0x42f7, uint(1)),
    el(0x4282, Buffer.from(o.docType ?? 'webm')),
    el(0x4287, uint(4)),
    el(0x4285, uint(2)),
  ]);
  const info = el(0x1549a966, [
    el(0x2ad7b1, uint(1_000_000)),
    el(0x4d80, Buffer.from('test-writer')),
  ]);
  const entry = (n: number) =>
    el(0xae, [
      el(0xd7, uint(n)),
      el(0x73c5, uint(n)),
      el(0x83, uint(o.trackType ?? 2)),
      el(0x86, Buffer.from(o.codec ?? 'A_OPUS')),
      ...(o.codecPrivate === null ? [] : [el(0x63a2, o.codecPrivate ?? opusHeadBytes(1))]),
      ...(o.codecDelayNs === null || o.codecDelayNs === undefined
        ? []
        : [el(0x56aa, uint(o.codecDelayNs))]),
      el(0xe1, [
        el(0xb5, Buffer.from([0x47, 0x3b, 0x80, 0x00])),
        ...(o.channels === null ? [] : [el(0x9f, uint(o.channels ?? 1))]),
      ]),
    ]);
  const tracks = el(
    0x1654ae6b,
    Array.from({ length: o.tracks ?? 1 }, (_, i) => entry(i + 1)),
  );
  const clusters: Buffer[] = [];
  for (let c = 0; c * perCluster < packets.length; c += 1) {
    const slice = packets.slice(c * perCluster, (c + 1) * perCluster);
    const blocks: Buffer[] = [];
    for (let i = 0; i < slice.length; i += perBlock) {
      const frames = slice.slice(i, i + perBlock);
      const tc = i * 20;
      if (o.blockGroup) blocks.push(el(0xa0, [el(0xa1, block(frames, lacing, false, tc))]));
      else blocks.push(el(0xa3, block(frames, frames.length > 1 ? lacing : 'none', true, tc)));
    }
    clusters.push(
      el(0x1f43b675, [el(0xe7, uint(c * perCluster * 20)), ...blocks], {
        unknownSize: o.unknownSizes ?? true,
      }),
    );
  }
  const body = o.tracksLast
    ? [info, clusters[0] as Buffer, tracks, ...clusters.slice(1)]
    : [info, tracks, ...clusters];
  // a Cues element after unknown-size clusters ends the last one
  const cues = el(0x1c53bb6b, [el(0xbb, [el(0xb3, uint(0))])]);
  const segment = el(0x18538067, [...body, cues], { unknownSize: o.unknownSizes ?? true });
  return Buffer.concat([header, segment]);
};

/** Parses Ogg pages back (tests check headers, CRCs, granules, packets). */
export const readOggPages = (ogg: Buffer) => {
  const pages: {
    flags: number;
    granule: bigint;
    sequence: number;
    crc: number;
    packets: Buffer[];
    raw: Buffer;
  }[] = [];
  let pos = 0;
  while (pos < ogg.length) {
    if (ogg.toString('latin1', pos, pos + 4) !== 'OggS')
      throw new Error(`no page at ${String(pos)}`);
    const segments = ogg[pos + 26] as number;
    const table = ogg.subarray(pos + 27, pos + 27 + segments);
    const dataLen = table.reduce((a, b) => a + b, 0);
    const end = pos + 27 + segments + dataLen;
    const packets: Buffer[] = [];
    let p = pos + 27 + segments;
    let current = 0;
    for (const s of table) {
      current += s;
      if (s < 255) {
        packets.push(ogg.subarray(p, p + current));
        p += current;
        current = 0;
      }
    }
    pages.push({
      flags: ogg[pos + 5] as number,
      granule: ogg.readBigInt64LE(pos + 6),
      sequence: ogg.readUInt32LE(pos + 18),
      crc: ogg.readUInt32LE(pos + 22),
      packets,
      raw: ogg.subarray(pos, end),
    });
    pos = end;
  }
  return pages;
};
