/** Ogg page writer (RFC 3533) + Ogg Opus headers (RFC 7845). */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg CRC-32: polynomial 0x04C11DB7, no reflection, init 0, no final xor. */
export const oggCrc = (data: Buffer): number => {
  let crc = 0;
  for (const byte of data)
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>> 0;
  return crc >>> 0;
};

export const OGG_FLAGS = { continued: 0x01, bos: 0x02, eos: 0x04 } as const;

/** One page holding whole packets (each ≤ 255 × 255 bytes; ≤ 255 lacing values in total). */
export const oggPage = (
  packets: Buffer[],
  opts: { granule: bigint; serial: number; sequence: number; flags: number },
): Buffer => {
  const segments: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      segments.push(255);
      n -= 255;
    }
    segments.push(n);
  }
  if (segments.length > 255) throw new Error('ogg page: too many segments');
  const header = Buffer.alloc(27 + segments.length);
  header.write('OggS', 0, 'latin1');
  header[4] = 0; // version
  header[5] = opts.flags;
  header.writeBigInt64LE(opts.granule, 6);
  header.writeUInt32LE(opts.serial >>> 0, 14);
  header.writeUInt32LE(opts.sequence >>> 0, 18);
  header.writeUInt32LE(0, 22); // CRC placeholder
  header[26] = segments.length;
  segments.forEach((s, i) => (header[27 + i] = s));
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
};

/** Lacing values a packet needs. */
export const segmentsFor = (packet: Buffer): number => Math.floor(packet.length / 255) + 1;

export const opusHead = (channels: number, preSkip: number, inputRate: number): Buffer => {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'latin1');
  b[8] = 1; // version
  b[9] = channels;
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(inputRate, 12);
  b.writeInt16LE(0, 16); // output gain
  b[18] = 0; // mapping family 0 (mono / stereo)
  return b;
};

export const opusTags = (vendor: string): Buffer => {
  const v = Buffer.from(vendor, 'utf8');
  const b = Buffer.alloc(8 + 4 + v.length + 4);
  b.write('OpusTags', 0, 'latin1');
  b.writeUInt32LE(v.length, 8);
  v.copy(b, 12);
  b.writeUInt32LE(0, 12 + v.length); // no comments
  return b;
};
