/**
 * Minimal, bounded EBML / Matroska reader for browser voice recordings (WebM / Opus).
 * Input is untrusted: every size is checked against the remaining bytes before use,
 * depth and element counts are capped, nothing is allocated from a size field.
 */
export class VoiceFormatError extends Error {
  constructor(
    readonly reason: 'corrupt' | 'not_allowed' | 'stereo_voice' | 'too_long' | 'too_short',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceFormatError';
  }
}

export const corrupt = (why: string): VoiceFormatError =>
  new VoiceFormatError('corrupt', `The recording is damaged (${why})`);

export const IDS = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Audio: 0xe1,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
  Void: 0xec,
} as const;

/** Elements that can follow a Cluster inside the Segment (they end an unknown-size Cluster). */
const SEGMENT_CHILDREN = new Set<number>([
  IDS.SeekHead,
  IDS.Info,
  IDS.Tracks,
  IDS.Cluster,
  IDS.Cues,
  IDS.Tags,
  IDS.Chapters,
  IDS.Attachments,
]);

const MAX_ELEMENTS = 500_000;
const MAX_DEPTH = 8;

export interface Element {
  id: number;
  /** Offset of the element's data. */
  start: number;
  /** End of the data (exclusive); unknown sizes end at the parent's end. */
  end: number;
  unknownSize: boolean;
}

export class EbmlReader {
  private elements = 0;

  constructor(readonly buf: Buffer) {}

  private count() {
    this.elements += 1;
    if (this.elements > MAX_ELEMENTS) throw corrupt('too many elements');
  }

  /** Variable-length integer at `pos`: `{ value, length, allOnes }` (marker removed). */
  vint(pos: number, keepMarker = false): { value: number; length: number; allOnes: boolean } {
    const first = this.buf[pos];
    if (first === undefined) throw corrupt('truncated');
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
    if (length > 8) throw corrupt('bad length');
    if (pos + length > this.buf.length) throw corrupt('truncated');
    let value = keepMarker ? first : first & (0xff >> length);
    let allOnes = value === 0xff >> length;
    for (let i = 1; i < length; i += 1) {
      const byte = this.buf[pos + i] as number;
      if (byte !== 0xff) allOnes = false;
      value = value * 256 + byte;
    }
    // all value bits set = "unknown size" (the value itself is meaningless then)
    if (!keepMarker && allOnes) return { value: 0, length, allOnes: true };
    if (!Number.isSafeInteger(value)) throw corrupt('size too large');
    return { value, length, allOnes: false };
  }

  /** The element header at `pos`, bounded by `limit`. */
  header(pos: number, limit: number): Element {
    this.count();
    const id = this.vint(pos, true);
    if (id.length > 4) throw corrupt('bad id');
    const size = this.vint(pos + id.length);
    const start = pos + id.length + size.length;
    if (start > limit) throw corrupt('truncated');
    if (size.allOnes) return { id: id.value, start, end: limit, unknownSize: true };
    const end = start + size.value;
    if (end > limit) {
      // a Segment / Cluster size beyond the file is cut to what is there (a recorder stopped
      // writing); any other element past its parent or the file end is damaged
      const container = id.value === IDS.Segment || id.value === IDS.Cluster;
      if (!container || limit !== this.buf.length) throw corrupt('truncated');
      return { id: id.value, start, end: limit, unknownSize: false };
    }
    return { id: id.value, start, end, unknownSize: false };
  }

  /**
   * Children of a master element `[start, end)`. For unknown-size Clusters the walk
   * stops at the next Segment-level element (`stoppedAt`).
   */
  children(parent: Element, depth: number): { items: Element[]; stoppedAt: number } {
    if (depth > MAX_DEPTH) throw corrupt('nested too deep');
    const items: Element[] = [];
    let pos = parent.start;
    const isCluster = parent.id === IDS.Cluster;
    while (pos < parent.end) {
      if (parent.end - pos < 2) break; // trailing padding byte
      const peek = this.vint(pos, true);
      if (parent.unknownSize && isCluster && SEGMENT_CHILDREN.has(peek.value)) {
        return { items, stoppedAt: pos };
      }
      const el = this.header(pos, parent.end);
      items.push(el);
      if (el.unknownSize && el.id !== IDS.Cluster && el.id !== IDS.Segment) {
        throw corrupt('unknown size where it is not allowed');
      }
      if (el.unknownSize) {
        // an unknown-size Cluster: walk it to find where it ends
        const inner = this.children(el, depth + 1);
        el.end = inner.stoppedAt;
        pos = inner.stoppedAt;
        continue;
      }
      pos = el.end;
    }
    return { items, stoppedAt: parent.end };
  }

  uint(el: Element): number {
    const len = el.end - el.start;
    if (len < 1 || len > 8) throw corrupt('bad number');
    let v = 0;
    for (let i = el.start; i < el.end; i += 1) v = v * 256 + (this.buf[i] as number);
    return v;
  }

  ascii(el: Element): string {
    return this.buf.toString('latin1', el.start, el.end).replace(/\0+$/, '');
  }

  bytes(el: Element): Buffer {
    return this.buf.subarray(el.start, el.end);
  }
}
