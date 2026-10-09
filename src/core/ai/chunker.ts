import { AI_LIMITS } from '../../config/limits';

export interface ChunkOptions {
  targetChars: number;
  overlapChars: number;
  maxChars: number;
  /** Title for text before the first heading (usually the source title). */
  fallbackTitle: string;
}

export interface TextChunk {
  order: number;
  title: string;
  text: string;
}

export const DEFAULT_CHUNK_OPTIONS: Omit<ChunkOptions, 'fallbackTitle'> = {
  targetChars: AI_LIMITS.chunkTargetChars,
  overlapChars: AI_LIMITS.chunkOverlapChars,
  maxChars: AI_LIMITS.chunkMaxChars,
};

const TITLE_MAX = 120;
const MARKDOWN_HEADING = /^#{1,6}\s+(.+?)\s*#*$/;
/** `1. Payment methods`, `2.3 Late fee`, `IV. Terms` — short lines only. */
const NUMBERED_HEADING = /^(?:\d+(?:\.\d+)*|[IVX]+)[.)]?\s+(\S.{0,100})$/;

const headingOf = (line: string): string | null => {
  const md = MARKDOWN_HEADING.exec(line);
  if (md?.[1]) return md[1];
  // a numbered line is a heading only when it is short and has no sentence end
  const num = NUMBERED_HEADING.exec(line);
  if (num?.[1] && line.length <= 80 && !/[.?!।]$/.test(line)) return num[1];
  return null;
};

interface Section {
  title: string | null;
  lines: string[];
}

const sections = (text: string): Section[] => {
  const out: Section[] = [{ title: null, lines: [] }];
  for (const line of text.split('\n')) {
    const heading = headingOf(line.trim());
    if (heading) out.push({ title: heading.slice(0, TITLE_MAX), lines: [line] });
    else out[out.length - 1]?.lines.push(line);
  }
  return out.filter((s) => s.lines.join('').trim());
};

/** Hard cut at `max`, preferring the last space in the second half. */
const hardCut = (text: string, max: number): string[] => {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const space = rest.lastIndexOf(' ', max);
    const at = space > max / 2 ? space : max;
    parts.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
};

/** Paragraph → pieces ≤ max: sentences (`. ? ! ।`) first, then a hard cut. */
const splitParagraph = (paragraph: string, max: number): string[] => {
  if (paragraph.length <= max) return [paragraph];
  const sentences = paragraph.split(/(?<=[.?!।])\s+/);
  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences.flatMap((s) => hardCut(s, max))) {
    if (current && current.length + 1 + sentence.length > max) {
      pieces.push(current);
      current = sentence;
    } else current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) pieces.push(current);
  return pieces;
};

/** The end of a chunk to repeat at the start of the next (≤ overlap chars, word boundary). */
const tailOf = (text: string, overlap: number): string => {
  if (overlap <= 0 || text.length <= overlap) return overlap > 0 ? text : '';
  const tail = text.slice(-overlap);
  const space = tail.indexOf(' ');
  return (space >= 0 ? tail.slice(space + 1) : tail).trim();
};

/**
 * Splits normalised text into retrieval chunks (PHASE_5_PROMPT §1 Chunker):
 * headings → blank-line paragraphs → sentences → hard cut. Chunks never cross
 * a heading; inside a section they overlap by ~`overlapChars`. Pure.
 */
export const chunkText = (text: string, options: ChunkOptions): TextChunk[] => {
  const { targetChars, overlapChars, maxChars } = options;
  const chunks: TextChunk[] = [];
  for (const section of sections(text)) {
    const title = section.title ?? options.fallbackTitle.slice(0, TITLE_MAX);
    const units = section.lines
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) => splitParagraph(p, targetChars));
    let current = '';
    let fresh = false; // current holds more than the overlap
    const flush = () => {
      if (current && fresh) chunks.push({ order: chunks.length, title, text: current });
    };
    for (const unit of units) {
      if (current && current.length + 2 + unit.length > targetChars) {
        flush();
        const tail = tailOf(current, overlapChars);
        current = tail && tail.length + 2 + unit.length <= maxChars ? tail : '';
        fresh = false;
      }
      current = current ? `${current}\n\n${unit}` : unit;
      fresh = true;
    }
    flush();
  }
  return chunks.map((c) => ({ ...c, text: c.text.slice(0, maxChars) }));
};
