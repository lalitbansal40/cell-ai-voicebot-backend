/**
 * File type from the first bytes (magic numbers) — uploads and downloads are
 * untrusted, the declared type and the file name are only hints (PHASE_10_PLAN §1l).
 */
export type SniffedKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export interface Sniffed {
  mime: string;
  ext: string;
  /** What the bytes can be sent as. */
  kinds: SniffedKind[];
}

const ascii = (b: Buffer, start: number, end: number) => b.toString('latin1', start, end);
const has = (b: Buffer, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** ZIP-based Office files: a `[Content_Types].xml` + the part folder among the first entries. */
const officeType = (b: Buffer): Sniffed | null => {
  const head = b.subarray(0, Math.min(b.length, 64 * 1024)).toString('latin1');
  if (!head.includes('[Content_Types].xml') && !/(word|xl|ppt)\//.test(head)) return null;
  if (head.includes('word/'))
    return {
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ext: 'docx',
      kinds: ['document'],
    };
  if (head.includes('xl/'))
    return {
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ext: 'xlsx',
      kinds: ['document'],
    };
  if (head.includes('ppt/'))
    return {
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ext: 'pptx',
      kinds: ['document'],
    };
  return null;
};

const isText = (b: Buffer): boolean => {
  if (!b.length || b.includes(0)) return false;
  const sample = b.subarray(0, Math.min(b.length, 8192));
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // a multi-byte character cut at the sample end is still text
    return sample.length === 8192;
  }
};

/** Sniffs `b`; null = not a type WhatsApp takes. */
export const sniff = (b: Buffer): Sniffed | null => {
  if (b.length < 4)
    return isText(b) ? { mime: 'text/plain', ext: 'txt', kinds: ['document'] } : null;
  if (has(b, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg', kinds: ['image'] };
  if (has(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return { mime: 'image/png', ext: 'png', kinds: ['image'] };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP')
    return { mime: 'image/webp', ext: 'webp', kinds: ['sticker'] };
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (brand === 'M4A ' || brand === 'M4B ')
      return { mime: 'audio/mp4', ext: 'm4a', kinds: ['audio'] };
    if (brand.startsWith('3gp') || brand.startsWith('3g2'))
      return { mime: 'video/3gpp', ext: '3gp', kinds: ['video'] };
    return { mime: 'video/mp4', ext: 'mp4', kinds: ['video'] };
  }
  if (ascii(b, 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg', kinds: ['audio'] };
  if (has(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: 'audio/webm', ext: 'webm', kinds: [] }; // voice notes only (remuxed)
  if (
    ascii(b, 0, 3) === 'ID3' ||
    (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && ((b[1] ?? 0) & 0x06) !== 0)
  )
    return { mime: 'audio/mpeg', ext: 'mp3', kinds: ['audio'] };
  if (b[0] === 0xff && ((b[1] ?? 0) & 0xf6) === 0xf0)
    return { mime: 'audio/aac', ext: 'aac', kinds: ['audio'] };
  if (ascii(b, 0, 6) === '#!AMR\n' || ascii(b, 0, 5) === '#!AMR')
    return { mime: 'audio/amr', ext: 'amr', kinds: ['audio'] };
  if (ascii(b, 0, 5) === '%PDF-')
    return { mime: 'application/pdf', ext: 'pdf', kinds: ['document'] };
  if (has(b, [0x50, 0x4b, 0x03, 0x04])) return officeType(b);
  if (has(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return { mime: 'application/msword', ext: 'doc', kinds: ['document'] };
  if (isText(b)) return { mime: 'text/plain', ext: 'txt', kinds: ['document'] };
  return null;
};

/** Does a Meta / browser mime type agree with the sniffed bytes (same top-level type)? */
export const mimeAgrees = (declared: string | null | undefined, sniffed: Sniffed): boolean => {
  if (!declared) return true;
  const d = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  if (d === sniffed.mime) return true;
  if (d === 'application/octet-stream') return true;
  const top = (m: string) => m.split('/')[0];
  // documents can be declared loosely (application/* vs text/plain); media must match their family
  if (sniffed.kinds.includes('document')) return top(d) === 'application' || top(d) === 'text';
  if (sniffed.mime === 'image/webp') return d === 'image/webp';
  return top(d) === top(sniffed.mime);
};
