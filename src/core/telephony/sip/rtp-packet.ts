/** RTP fixed header (RFC 3550 §5.1); no CSRC lists or extensions are sent by Asterisk here. */
export interface RtpPacket {
  payloadType: number;
  marker: boolean;
  seq: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}

export const RTP_HEADER_BYTES = 12;

/** `null` for anything that is not an RTP version 2 packet with a payload. */
export const parseRtp = (buf: Uint8Array): RtpPacket | null => {
  if (buf.length <= RTP_HEADER_BYTES) return null;
  const b0 = buf[0] as number;
  if (b0 >> 6 !== 2) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const csrc = b0 & 0x0f;
  let offset = RTP_HEADER_BYTES + csrc * 4;
  if (b0 & 0x10) {
    if (buf.length < offset + 4) return null;
    offset += 4 + view.getUint16(offset + 2) * 4;
  }
  let end = buf.length;
  if (b0 & 0x20) end -= buf[buf.length - 1] as number;
  if (end <= offset) return null;
  const b1 = buf[1] as number;
  return {
    payloadType: b1 & 0x7f,
    marker: (b1 & 0x80) !== 0,
    seq: view.getUint16(2),
    timestamp: view.getUint32(4),
    ssrc: view.getUint32(8),
    payload: buf.subarray(offset, end),
  };
};

export const buildRtp = (p: RtpPacket): Buffer => {
  const buf = Buffer.alloc(RTP_HEADER_BYTES + p.payload.length);
  buf[0] = 0x80;
  buf[1] = (p.marker ? 0x80 : 0) | (p.payloadType & 0x7f);
  buf.writeUInt16BE(p.seq & 0xffff, 2);
  buf.writeUInt32BE(p.timestamp >>> 0, 4);
  buf.writeUInt32BE(p.ssrc >>> 0, 8);
  buf.set(p.payload, RTP_HEADER_BYTES);
  return buf;
};

/** Signed distance from `b` to `a` on the 16-bit sequence circle. */
export const seqDiff = (a: number, b: number): number => {
  const d = (a - b) & 0xffff;
  return d >= 0x8000 ? d - 0x10000 : d;
};
