/**
 * RFC 4733 telephone events (DTMF) for WhatsApp calls (Meta: `telephone-event/8000`).
 * Payload: event (8 bits) | E (end) | R | volume (6 bits) | duration (16 bits,
 * in 8 kHz samples). A digit is several packets with the same RTP timestamp;
 * the last three carry the end bit.
 */
export const DTMF_DIGITS = '0123456789*#';
export const DTMF_CLOCK = 8_000;

const EVENT_FOR: Record<string, number> = Object.fromEntries(
  [...DTMF_DIGITS].map((d, i) => [d, i] as const),
);

export interface DtmfEvent {
  digit: string;
  end: boolean;
  duration: number;
}

export const encodeDtmf = (digit: string, durationSamples: number, end: boolean): Buffer => {
  const event = EVENT_FOR[digit];
  if (event === undefined) throw new RangeError('Not a DTMF digit');
  const buf = Buffer.alloc(4);
  buf.writeUInt8(event, 0);
  // end bit + volume 10 (−10 dBm0)
  buf.writeUInt8((end ? 0x80 : 0) | 10, 1);
  buf.writeUInt16BE(Math.min(durationSamples, 0xffff), 2);
  return buf;
};

export const decodeDtmf = (payload: Buffer): DtmfEvent | null => {
  if (payload.length < 4) return null;
  const event = payload.readUInt8(0);
  const digit = DTMF_DIGITS[event];
  if (digit === undefined) return null;
  return { digit, end: (payload.readUInt8(1) & 0x80) !== 0, duration: payload.readUInt16BE(2) };
};

/**
 * Packets for one digit: every 20 ms while held (`toneMs`), then three end
 * packets, all with the digit's start timestamp (in the 48 kHz media clock the
 * timestamp is shared with Opus; the duration counts 8 kHz samples per RFC 4733).
 */
export const dtmfPackets = (digit: string, toneMs = 100): Buffer[] => {
  const step = (DTMF_CLOCK * 20) / 1000;
  const total = (DTMF_CLOCK * toneMs) / 1000;
  const out: Buffer[] = [];
  for (let d = step; d < total; d += step) out.push(encodeDtmf(digit, d, false));
  for (let i = 0; i < 3; i += 1) out.push(encodeDtmf(digit, total, true));
  return out;
};

/** Receiver: reports each digit once (on its first end packet), keyed by RTP timestamp. */
export class DtmfReceiver {
  private lastTimestamp: number | null = null;

  constructor(private readonly onDigit: (digit: string) => void) {}

  push(payload: Buffer, timestamp: number): void {
    const ev = decodeDtmf(payload);
    if (!ev?.end || timestamp === this.lastTimestamp) return;
    this.lastTimestamp = timestamp;
    this.onDigit(ev.digit);
  }
}
