import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { dbfs, tone } from '../../voice/audio/pcm';
import { Resampler } from '../../voice/audio/resample';
import { readWav } from '../../voice/audio/wav';

import { createOpusCodec, OPUS_FRAME_SAMPLES, OPUS_RATE, type OpusCodec } from './codec';
import { dtmfPackets, DTMF_DIGITS } from './dtmf';
import { DTMF_PT, OPUS_PT, WhatsAppPeer } from './peer';
import { hasTone } from './tones';

/**
 * DEV / TEST ONLY — the customer's phone behind the fake Meta (PHASE_12_PROMPT §1).
 * A Meta-like ICE-lite werift peer on 127.0.0.1 that plays `customer-tone.wav`
 * (440 Hz) in a loop once the call is answered, listens for the agent / bot (a
 * 1 kHz tone detector + level meter), sends RFC 4733 digits and hangs up.
 * Imported only by the fake Meta client and tests.
 */
export const CUSTOMER_TONE_HZ = 440;
export const AGENT_TONE_HZ = 1_000;

const FRAME_MS = 20;
/** Window of heard audio checked for the agent tone (0.5 s at 48 kHz). */
const HEAR_WINDOW = OPUS_RATE / 2;

const TONE_FILE = path.resolve(__dirname, '../../../../docs/samples/audio/customer-tone.wav');

let cachedTone: Int16Array | null = null;

/** The customer's audio at 48 kHz: the sample file, else the same tone generated. */
const customerAudio = (): Int16Array => {
  if (cachedTone) return cachedTone;
  let pcm48: Int16Array;
  if (existsSync(TONE_FILE)) {
    const wav = readWav(readFileSync(TONE_FILE));
    pcm48 = wav.rate === OPUS_RATE ? wav.pcm : new Resampler(wav.rate, OPUS_RATE).process(wav.pcm);
  } else {
    pcm48 = tone(3_000, OPUS_RATE, { hz: CUSTOMER_TONE_HZ, amplitude: 8_000 });
  }
  // whole frames only (the loop restarts on a frame boundary)
  cachedTone = pcm48.subarray(0, pcm48.length - (pcm48.length % OPUS_FRAME_SAMPLES));
  return cachedTone;
};

export interface FakeWaUserStats {
  connected: boolean;
  /** The agent / bot tone (1 kHz) was heard at least once. */
  heardTone: boolean;
  /** Loudest heard 20 ms frame (dBFS), `null` before any audio. */
  heardLevel: number | null;
  /** Digits sent so far (dev view; never logged). */
  dtmfSent: string;
  packetsIn: number;
  packetsOut: number;
}

export class FakeWaUser {
  private readonly peer = new WhatsAppPeer({ role: 'meta', bindAddress: '127.0.0.1' });
  private readonly codec: OpusCodec = createOpusCodec();
  private timer: NodeJS.Timeout | null = null;
  private offset = 0;
  private heard: Int16Array[] = [];
  private heardSamples = 0;
  private closed = false;
  private readonly endFns: (() => void)[] = [];
  readonly stats: FakeWaUserStats = {
    connected: false,
    heardTone: false,
    heardLevel: null,
    dtmfSent: '',
    packetsIn: 0,
    packetsOut: 0,
  };

  constructor() {
    this.peer.onState((state) => {
      if (state === 'connected') this.stats.connected = true;
      if (state === 'failed' || state === 'closed') this.finish();
    });
    this.peer.onPacket((p) => {
      if (this.closed || p.payloadType !== OPUS_PT) return;
      this.stats.packetsIn += 1;
      const pcm = this.codec.decode(p.payload);
      if (pcm.length) {
        const level = dbfs(pcm);
        if (Number.isFinite(level)) {
          this.stats.heardLevel = Math.max(this.stats.heardLevel ?? -Infinity, level);
        }
      }
      this.listen(pcm);
    });
  }

  /** Business-initiated call: our offer → the customer's answer (Meta's relay answers). */
  answer(offerSdp: string): Promise<string> {
    return this.peer.answer(offerSdp);
  }

  /** User-initiated call: the customer's offer (Meta sends it in the `connect` webhook). */
  offer(): Promise<string> {
    return this.peer.createOffer();
  }

  applyAnswer(answerSdp: string): Promise<void> {
    return this.peer.applyAnswer(answerSdp);
  }

  get connected(): Promise<void> {
    return this.peer.connected;
  }

  /** Starts the customer's audio (looped tone) every 20 ms — the call was picked up. */
  startTalking(): void {
    if (this.timer || this.closed) return;
    const audio = customerAudio();
    this.timer = setInterval(() => {
      const frame = audio.subarray(this.offset, this.offset + OPUS_FRAME_SAMPLES);
      this.offset = (this.offset + OPUS_FRAME_SAMPLES) % audio.length;
      this.peer.sendPacket(OPUS_PT, this.codec.encode(frame), { samples: OPUS_FRAME_SAMPLES });
      this.stats.packetsOut += 1;
    }, FRAME_MS);
    this.timer.unref();
  }

  /** Presses keys (RFC 4733; each digit 100 ms + 3 end packets, spaced 60 ms). */
  async pressDigits(digits: string): Promise<void> {
    for (const digit of digits) {
      if (this.closed || !DTMF_DIGITS.includes(digit)) continue;
      const start = this.peer.rtpTimestamp;
      const packets = dtmfPackets(digit);
      for (const [i, payload] of packets.entries()) {
        this.peer.sendPacket(DTMF_PT, payload, { samples: 0, marker: i === 0, timestamp: start });
        await sleep(FRAME_MS);
      }
      this.peer.advance(OPUS_FRAME_SAMPLES * packets.length);
      this.stats.dtmfSent += digit;
      await sleep(60);
    }
  }

  onEnd(fn: () => void): void {
    this.endFns.push(fn);
  }

  /** The customer hangs up (also used when Meta ends the call). */
  async hangup(): Promise<void> {
    if (this.closed) return;
    this.finish();
    await this.peer.close();
  }

  private listen(pcm: Int16Array): void {
    if (this.stats.heardTone) return;
    this.heard.push(pcm);
    this.heardSamples += pcm.length;
    if (this.heardSamples < HEAR_WINDOW) return;
    const all = new Int16Array(this.heardSamples);
    let o = 0;
    for (const part of this.heard) {
      all.set(part, o);
      o += part.length;
    }
    this.stats.heardTone = hasTone(all, OPUS_RATE, AGENT_TONE_HZ, CUSTOMER_TONE_HZ);
    this.heard = [];
    this.heardSamples = 0;
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.codec.destroy();
    for (const fn of this.endFns.splice(0)) fn();
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
