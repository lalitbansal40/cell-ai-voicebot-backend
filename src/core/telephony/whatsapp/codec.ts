import OpusScript from 'opusscript';

/**
 * Opus for WhatsApp calls (Meta: 48 kHz, 20 ms frames, one channel of audio).
 * `opusscript` (libopus compiled to WASM / asm.js) — no native build, so the
 * same code runs on macOS (dev) and Linux (CI, servers). The native
 * `@discordjs/opus` was tried in the PoC and hung / crashed on Node 24 (ADR 0040).
 */
export const OPUS_RATE = 48_000;
export const OPUS_FRAME_MS = 20;
/** Samples per 20 ms frame at 48 kHz. */
export const OPUS_FRAME_SAMPLES = (OPUS_RATE * OPUS_FRAME_MS) / 1000;
/** VoIP-quality speech (Meta's guidance: ≈ 40 kbps per call incl. overhead). */
export const OPUS_BITRATE = 24_000;

export interface OpusCodec {
  /** One 20 ms frame of PCM16 mono 48 kHz → one Opus packet. */
  encode(pcm48: Int16Array): Buffer;
  /** One Opus packet → PCM16 mono 48 kHz (an empty packet → one frame of silence). */
  decode(packet: Buffer): Int16Array;
  destroy(): void;
}

const toBuffer = (pcm: Int16Array): Buffer => {
  if (pcm.length !== OPUS_FRAME_SAMPLES) {
    throw new RangeError(`Opus frames are ${String(OPUS_FRAME_SAMPLES)} samples`);
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
};

const toPcm = (buf: Buffer): Int16Array => {
  const out = new Int16Array(buf.length >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readInt16LE(i * 2);
  return out;
};

export const createOpusCodec = (): OpusCodec => {
  const opus = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
  opus.setBitrate(OPUS_BITRATE);
  let destroyed = false;
  return {
    encode: (pcm) => opus.encode(toBuffer(pcm), OPUS_FRAME_SAMPLES),
    decode: (packet) =>
      packet.length === 0 ? new Int16Array(OPUS_FRAME_SAMPLES) : toPcm(opus.decode(packet)),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      opus.delete();
    },
  };
};
