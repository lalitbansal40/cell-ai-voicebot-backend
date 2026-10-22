import { INBOX_LIMITS } from '../../../config/limits';

import { corrupt, EbmlReader, IDS, VoiceFormatError, type Element } from './ebml';
import { OGG_FLAGS, oggPage, opusHead, opusTags, segmentsFor } from './ogg';
import { opusPacketSamples } from './opus-toc';

export { VoiceFormatError } from './ebml';

/** Largest recording accepted for remuxing (WhatsApp audio cap). */
const MAX_INPUT = INBOX_LIMITS.audioMaxBytes;
const SAMPLE_RATE = 48_000;
const DEFAULT_PRE_SKIP = 312;
/** Packets / bytes per Ogg page (keeps pages small; ≤ 255 lacing values). */
const PAGE_MAX_PACKETS = 50;
const PAGE_MAX_BYTES = 8 * 1024;

interface Track {
  number: number;
  codec: string;
  channels: number | null;
  codecPrivate: Buffer | null;
  codecDelayNs: number | null;
}

const readTrack = (r: EbmlReader, entry: Element): Track => {
  const t: Track = { number: 0, codec: '', channels: null, codecPrivate: null, codecDelayNs: null };
  let type = 0;
  for (const el of r.children(entry, 3).items) {
    if (el.id === IDS.TrackNumber) t.number = r.uint(el);
    else if (el.id === IDS.TrackType) type = r.uint(el);
    else if (el.id === IDS.CodecID) t.codec = r.ascii(el);
    else if (el.id === IDS.CodecPrivate) t.codecPrivate = Buffer.from(r.bytes(el));
    else if (el.id === IDS.CodecDelay) t.codecDelayNs = r.uint(el);
    else if (el.id === IDS.Audio) {
      for (const a of r.children(el, 4).items) if (a.id === IDS.Channels) t.channels = r.uint(a);
    }
  }
  if (type !== 2) throw new VoiceFormatError('not_allowed', 'Only audio recordings can be sent');
  return t;
};

/** Frames of one (Simple)Block payload (no lacing, Xiph, fixed or EBML lacing). */
const blockFrames = (r: EbmlReader, block: Element, trackNumber: number): Buffer[] => {
  const track = r.vint(block.start);
  let pos = block.start + track.length + 3; // timecode (2) + flags (1)
  if (pos > block.end) throw corrupt('short block');
  if (track.value !== trackNumber) throw corrupt('block of another track');
  const flags = r.buf[pos - 1] as number;
  const lacing = (flags >> 1) & 0x03;
  if (lacing === 0) return [r.buf.subarray(pos, block.end)];
  const count = (r.buf[pos] as number) + 1;
  pos += 1;
  const sizes: number[] = [];
  if (lacing === 1) {
    // Xiph: 255-continued sizes for all frames but the last
    for (let i = 0; i < count - 1; i += 1) {
      let size = 0;
      for (;;) {
        const b = r.buf[pos];
        if (b === undefined || pos >= block.end) throw corrupt('bad lacing');
        pos += 1;
        size += b;
        if (b < 255) break;
      }
      sizes.push(size);
    }
  } else if (lacing === 3) {
    // EBML: the first size, then signed differences
    const first = r.vint(pos);
    pos += first.length;
    sizes.push(first.value);
    for (let i = 1; i < count - 1; i += 1) {
      const d = r.vint(pos);
      pos += d.length;
      const bias = 2 ** (7 * d.length - 1) - 1;
      const size = (sizes[i - 1] as number) + d.value - bias;
      if (size < 0) throw corrupt('bad lacing');
      sizes.push(size);
    }
  } else {
    const remaining = block.end - pos;
    if (remaining % count !== 0) throw corrupt('bad lacing');
    for (let i = 0; i < count - 1; i += 1) sizes.push(remaining / count);
  }
  const used = sizes.reduce((a, b) => a + b, 0);
  const last = block.end - pos - used;
  if (last < 0) throw corrupt('bad lacing');
  sizes.push(last);
  const frames: Buffer[] = [];
  for (const size of sizes) {
    frames.push(r.buf.subarray(pos, pos + size));
    pos += size;
  }
  return frames;
};

export interface RemuxResult {
  ogg: Buffer;
  durationSec: number;
  packets: number;
}

/**
 * A browser's WebM / Opus voice recording → OGG / Opus (no re-encoding): one mono
 * Opus track required; OpusHead taken from CodecPrivate (or built); every Opus
 * packet copied into Ogg pages with granule positions from the TOC sample counts.
 * Throws `VoiceFormatError` (`corrupt` / `not_allowed` / `stereo_voice` /
 * `too_long` / `too_short`).
 */
export const remuxWebmOpusToOgg = (input: Buffer): RemuxResult => {
  if (input.length > MAX_INPUT)
    throw new VoiceFormatError('too_long', 'The recording is too large');
  const r = new EbmlReader(input);
  const root: Element = { id: 0, start: 0, end: input.length, unknownSize: false };
  const top = r.children(root, 0).items;
  const header = top[0];
  if (header?.id !== IDS.EBML) throw new VoiceFormatError('not_allowed', 'Not a WebM recording');
  const docType = r.children(header, 1).items.find((e) => e.id === IDS.DocType);
  const doc = docType ? r.ascii(docType) : '';
  if (doc !== 'webm' && doc !== 'matroska') {
    throw new VoiceFormatError('not_allowed', 'Not a WebM recording');
  }
  const segment = top.find((e) => e.id === IDS.Segment);
  if (!segment) throw corrupt('no segment');

  const tracks: Track[] = [];
  const packets: Buffer[] = [];
  let trackNumber: number | null = null;
  const pending: Element[] = [];
  for (const el of r.children(segment, 1).items) {
    if (el.id === IDS.Tracks) {
      for (const entry of r.children(el, 2).items) {
        if (entry.id === IDS.TrackEntry) tracks.push(readTrack(r, entry));
      }
      if (tracks.length !== 1) {
        throw new VoiceFormatError('not_allowed', 'A voice note must have exactly one audio track');
      }
      const t = tracks[0] as Track;
      if (t.codec !== 'A_OPUS')
        throw new VoiceFormatError(
          'not_allowed',
          'Only Opus recordings can be sent as voice notes',
        );
      trackNumber = t.number;
      // clusters seen before the Tracks element (never in browser files, but legal)
      for (const c of pending.splice(0)) packets.push(...clusterPackets(r, c, trackNumber));
    } else if (el.id === IDS.Cluster) {
      if (trackNumber === null) pending.push(el);
      else packets.push(...clusterPackets(r, el, trackNumber));
    }
  }
  const track = tracks[0];
  if (!track || trackNumber === null) throw corrupt('no audio track');

  let head: Buffer;
  if (
    track.codecPrivate &&
    track.codecPrivate.length >= 19 &&
    track.codecPrivate.toString('latin1', 0, 8) === 'OpusHead'
  ) {
    head = track.codecPrivate.subarray(0, 19);
  } else {
    const preSkip =
      track.codecDelayNs !== null
        ? Math.round((track.codecDelayNs * SAMPLE_RATE) / 1e9)
        : DEFAULT_PRE_SKIP;
    head = opusHead(track.channels ?? 1, Math.min(preSkip, 65_535), SAMPLE_RATE);
  }
  const channels = head[9] as number;
  if (channels !== 1 || (track.channels !== null && track.channels !== 1)) {
    throw new VoiceFormatError('stereo_voice', 'Voice notes must be mono');
  }
  if (!packets.length) throw new VoiceFormatError('too_short', 'The recording is empty');

  const serial = 0x6361_6900; // "cai\0"
  const pages: Buffer[] = [
    oggPage([Buffer.from(head)], { granule: 0n, serial, sequence: 0, flags: OGG_FLAGS.bos }),
    oggPage([opusTags('cell-ai')], { granule: 0n, serial, sequence: 1, flags: 0 }),
  ];
  let granule = 0;
  let sequence = 2;
  let batch: Buffer[] = [];
  let batchBytes = 0;
  let batchSegments = 0;
  const flush = (last: boolean) => {
    pages.push(
      oggPage(batch, {
        granule: BigInt(granule),
        serial,
        sequence,
        flags: last ? OGG_FLAGS.eos : 0,
      }),
    );
    sequence += 1;
    batch = [];
    batchBytes = 0;
    batchSegments = 0;
  };
  packets.forEach((p, i) => {
    const segs = segmentsFor(p);
    if (
      batch.length &&
      (batch.length >= PAGE_MAX_PACKETS ||
        batchBytes + p.length > PAGE_MAX_BYTES ||
        batchSegments + segs > 255)
    ) {
      flush(false);
    }
    if (segs > 255) throw corrupt('audio packet too large');
    granule += opusPacketSamples(p);
    batch.push(p);
    batchBytes += p.length;
    batchSegments += segs;
    if (i === packets.length - 1) flush(true);
  });
  const preSkip = head.readUInt16LE(10);
  const durationSec = Math.max(0, granule - preSkip) / SAMPLE_RATE;
  if (durationSec > INBOX_LIMITS.voiceNoteMaxSeconds) {
    throw new VoiceFormatError('too_long', 'Voice notes can be at most 10 minutes');
  }
  if (durationSec * 1000 < INBOX_LIMITS.voiceNoteMinMs) {
    throw new VoiceFormatError('too_short', 'The recording is shorter than 1 second');
  }
  return {
    ogg: Buffer.concat(pages),
    durationSec: Math.round(durationSec * 10) / 10,
    packets: packets.length,
  };
};

const clusterPackets = (r: EbmlReader, cluster: Element, trackNumber: number): Buffer[] => {
  const out: Buffer[] = [];
  for (const el of r.children(cluster, 2).items) {
    if (el.id === IDS.SimpleBlock) out.push(...blockFrames(r, el, trackNumber));
    else if (el.id === IDS.BlockGroup) {
      for (const b of r.children(el, 3).items) {
        if (b.id === IDS.Block) out.push(...blockFrames(r, b, trackNumber));
      }
    }
  }
  return out.filter((p) => p.length > 0);
};

/** Checks an uploaded OGG voice note: OggS + OpusHead, mono; returns its duration (from the last granule). */
export const inspectOggOpus = (input: Buffer): { durationSec: number } => {
  if (input.length < 47 || input.toString('latin1', 0, 4) !== 'OggS') {
    throw new VoiceFormatError('not_allowed', 'Not an OGG recording');
  }
  const segments = input[26] as number;
  const headStart = 27 + segments;
  if (input.toString('latin1', headStart, headStart + 8) !== 'OpusHead') {
    throw new VoiceFormatError('not_allowed', 'Only Opus recordings can be sent as voice notes');
  }
  if (input[headStart + 9] !== 1)
    throw new VoiceFormatError('stereo_voice', 'Voice notes must be mono');
  const preSkip = input.readUInt16LE(headStart + 10);
  // granule of the last page
  const last = input.lastIndexOf('OggS', input.length - 4, 'latin1');
  if (last < 0 || last + 14 > input.length) throw corrupt('no pages');
  const granule = Number(input.readBigInt64LE(last + 6));
  const durationSec = Math.max(0, granule - preSkip) / SAMPLE_RATE;
  if (durationSec > INBOX_LIMITS.voiceNoteMaxSeconds) {
    throw new VoiceFormatError('too_long', 'Voice notes can be at most 10 minutes');
  }
  if (durationSec * 1000 < INBOX_LIMITS.voiceNoteMinMs) {
    throw new VoiceFormatError('too_short', 'The recording is shorter than 1 second');
  }
  return { durationSec: Math.round(durationSec * 10) / 10 };
};
