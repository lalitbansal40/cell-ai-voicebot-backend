import { createRequire } from 'node:module';

/**
 * Opus for WhatsApp calls (Meta: 48 kHz, 20 ms frames, one channel of audio).
 * libopus compiled to WASM from the `opusscript` package — no native build, so the
 * same code runs on macOS (dev) and Linux (CI, servers). The native
 * `@discordjs/opus` was tried in the PoC and hung / crashed on Node 24 (ADR 0040).
 *
 * We drive opusscript's emscripten module directly instead of its JS wrapper: the
 * wrapper caches heap views at construction (they detach when the WASM memory
 * grows with more calls) and indexes its 16-bit views with byte pointers, so with
 * many codecs alive it wrote outside its buffers (T12.4, ADR 0040). Here every call
 * takes a fresh view of the current heap at the exact byte offset. opusscript's C
 * side takes / returns PCM as one byte per 16-bit slot (what the wrapper's
 * `HEAPU16.set(Buffer)` produced); that layout is kept here.
 */
export const OPUS_RATE = 48_000;
export const OPUS_FRAME_MS = 20;
/** Samples per 20 ms frame at 48 kHz. */
export const OPUS_FRAME_SAMPLES = (OPUS_RATE * OPUS_FRAME_MS) / 1000;
/** VoIP-quality speech (Meta's guidance: ≈ 40 kbps per call incl. overhead). */
export const OPUS_BITRATE = 24_000;

const OPUS_APPLICATION_VOIP = 2048;
const OPUS_SET_BITRATE = 4002;
/** libopus: the largest packet of one frame (3 × 1276 like opusscript). */
const MAX_PACKET_BYTES = 1276 * 3;
/** 60 ms at 48 kHz — the largest frame a decoder may return. */
const MAX_FRAME_SAMPLES = 2_880;

const OPUS_ERRORS: Record<string, string> = {
  '-1': 'Bad argument',
  '-2': 'Buffer too small',
  '-3': 'Internal error',
  '-4': 'Invalid packet',
  '-5': 'Unimplemented',
  '-6': 'Invalid state',
  '-7': 'Memory allocation fail',
};

interface OpusHandler {
  _encode(inPtr: number, inBytes: number, outPtr: number, frameSize: number): number;
  _decode(inPtr: number, inBytes: number, outPtr: number): number;
  _encoder_ctl(ctl: number, arg: number): number;
}

interface OpusNative {
  OpusScriptHandler: {
    new (rate: number, channels: number, application: number): OpusHandler;
    destroy_handler(handler: OpusHandler): void;
  };
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  /** Re-created by emscripten whenever the memory grows — always read them fresh. */
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
}

let native: OpusNative | null = null;
const opusNative = (): OpusNative => {
  if (!native) {
    const load = createRequire(__filename)(
      'opusscript/build/opusscript_native_wasm.js',
    ) as () => OpusNative;
    native = load();
  }
  return native;
};

export interface OpusCodec {
  /** One 20 ms frame of PCM16 mono 48 kHz → one Opus packet. */
  encode(pcm48: Int16Array): Buffer;
  /** One Opus packet → PCM16 mono 48 kHz (an empty packet → one frame of silence). */
  decode(packet: Buffer): Int16Array;
  destroy(): void;
}

const check = (len: number, what: string): number => {
  if (len < 0) throw new Error(`${what} error: ${OPUS_ERRORS[String(len)] ?? String(len)}`);
  return len;
};

export const createOpusCodec = (): OpusCodec => {
  const m = opusNative();
  const handler = new m.OpusScriptHandler(OPUS_RATE, 1, OPUS_APPLICATION_VOIP);
  check(handler._encoder_ctl(OPUS_SET_BITRATE, OPUS_BITRATE), 'Encoder CTL');
  // two bytes per sample, each in its own 16-bit slot
  const pcmBytes = MAX_FRAME_SAMPLES * 2 * 2;
  const inPcm = m._malloc(pcmBytes);
  const inPacket = m._malloc(MAX_PACKET_BYTES);
  const outPacket = m._malloc(MAX_PACKET_BYTES);
  const outPcm = m._malloc(pcmBytes);
  let destroyed = false;
  const alive = () => {
    if (destroyed) throw new Error('Opus codec used after destroy');
  };
  return {
    encode(pcm) {
      alive();
      if (pcm.length !== OPUS_FRAME_SAMPLES) {
        throw new RangeError(`Opus frames are ${String(OPUS_FRAME_SAMPLES)} samples`);
      }
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      m.HEAPU16.set(bytes, inPcm >> 1);
      const len = check(
        handler._encode(inPcm, bytes.length, outPacket, OPUS_FRAME_SAMPLES),
        'Encode',
      );
      return Buffer.from(m.HEAPU8.slice(outPacket, outPacket + len));
    },
    decode(packet) {
      alive();
      if (packet.length === 0) return new Int16Array(OPUS_FRAME_SAMPLES);
      if (packet.length > MAX_PACKET_BYTES) throw new RangeError('Opus packet too large');
      m.HEAPU8.set(packet, inPacket);
      const samples = check(handler._decode(inPacket, packet.length, outPcm), 'Decode');
      const slots = m.HEAPU16.subarray(outPcm >> 1, (outPcm >> 1) + samples * 2);
      const out = new Int16Array(samples);
      for (let i = 0; i < samples; i += 1) {
        // little-endian bytes from consecutive slots
        out[i] = (((slots[2 * i + 1] ?? 0) & 0xff) << 8) | ((slots[2 * i] ?? 0) & 0xff);
      }
      return out;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      m.OpusScriptHandler.destroy_handler(handler);
      for (const ptr of [inPcm, inPacket, outPacket, outPcm]) m._free(ptr);
    },
  };
};
