/** Minimal RTP (RFC 3550) parsing + G.711 μ-law helpers for the lab. */
export interface RtpPacket {
  version: number;
  payloadType: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
}

export const parseRtp = (buf: Buffer): RtpPacket | undefined => {
  if (buf.length < 12) return undefined;
  const b0 = buf[0] ?? 0;
  const version = b0 >> 6;
  if (version !== 2) return undefined;
  const csrcCount = b0 & 0x0f;
  const hasExtension = (b0 >> 4) & 0x01;
  let offset = 12 + csrcCount * 4;
  if (hasExtension) {
    if (buf.length < offset + 4) return undefined;
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  const hasPadding = (b0 >> 5) & 0x01;
  const end = hasPadding ? buf.length - (buf[buf.length - 1] ?? 0) : buf.length;
  if (offset > end) return undefined;
  return {
    version,
    payloadType: (buf[1] ?? 0) & 0x7f,
    sequence: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    payload: buf.subarray(offset, end),
  };
};

const BIAS = 0x84;
const CLIP = 32635;

export const linearToMulaw = (sample: number): number => {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
};

/** WAV with G.711 μ-law (format 7), 8 kHz mono. */
export const mulawWav = (bytes: Uint8Array): Buffer => {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + bytes.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(7, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24);
  h.writeUInt32LE(8000, 28);
  h.writeUInt16LE(1, 32);
  h.writeUInt16LE(8, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(bytes.length, 40);
  return Buffer.concat([h, Buffer.from(bytes)]);
};
