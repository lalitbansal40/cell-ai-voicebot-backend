import { describe, expect, it } from 'vitest';

import { chunkText, DEFAULT_CHUNK_OPTIONS } from './chunker';

const opts = (over: Partial<typeof DEFAULT_CHUNK_OPTIONS> = {}) => ({
  ...DEFAULT_CHUNK_OPTIONS,
  fallbackTitle: 'Source title',
  ...over,
});

describe('chunkText', () => {
  it('splits by markdown and numbered headings, titles chunks by them', () => {
    const text = [
      'Intro line before any heading.',
      '# Payment methods',
      'Pay by UPI.',
      '## Late fee',
      'Fifty rupees a day.',
      '3. Contact hours',
      'Nine to seven.',
      '4. This numbered line ends with a full stop.',
    ].join('\n');
    const chunks = chunkText(text, opts());
    expect(chunks.map((c) => [c.order, c.title])).toEqual([
      [0, 'Source title'],
      [1, 'Payment methods'],
      [2, 'Late fee'],
      [3, 'Contact hours'],
    ]);
    expect(chunks[3]?.text).toContain('4. This numbered line ends with a full stop.');
  });

  it('packs paragraphs up to the target with overlap', () => {
    const para = (n: number) => `Paragraph ${n} ${'word '.repeat(40).trim()}.`;
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(text, opts({ targetChars: 600, overlapChars: 120, maxChars: 800 }));
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(800);
    // each chunk starts with the end of the previous one
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1]?.text ?? '';
      const head = (chunks[i]?.text ?? '').split('\n\n')[0] ?? '';
      expect(prev.endsWith(head)).toBe(true);
    }
    expect(chunks.map((c) => c.text).join(' ')).toContain('Paragraph 11');
  });

  it('splits long paragraphs at sentence ends, incl. the Devanagari danda', () => {
    const sentence = (i: number) => `यह वाक्य संख्या ${i} है और इसमें कुछ शब्द हैं।`;
    const long = Array.from({ length: 60 }, (_, i) => sentence(i)).join(' ');
    const chunks = chunkText(long, opts({ targetChars: 400, overlapChars: 0, maxChars: 500 }));
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500);
      expect(c.text.endsWith('।')).toBe(true);
    }
  });

  it('hard-cuts text without sentence ends', () => {
    const blob = 'x'.repeat(9_000);
    const chunks = chunkText(blob, opts());
    // 3,200-char pieces; later chunks start with a 480-char overlap (still ≤ 4,000)
    expect(chunks.map((c) => c.text.length)).toEqual([3200, 480 + 2 + 3200, 480 + 2 + 2600]);
    const words = Array.from({ length: 2_000 }, (_, i) => `w${i}`).join(' ');
    for (const c of chunkText(words, opts())) expect(c.text.length).toBeLessThanOrEqual(4000);
  });

  it('returns nothing for empty text and caps titles at 120 chars', () => {
    expect(chunkText('', opts())).toEqual([]);
    expect(chunkText('\n\n  \n', opts())).toEqual([]);
    const [c] = chunkText(`# ${'T'.repeat(200)}\nbody`, opts());
    expect(c?.title).toHaveLength(120);
  });

  it('keeps tables written as text intact', () => {
    const table = ['Plan | EMI | Tenure', 'Silver | ₹2,500 | 12', 'Gold | ₹4,000 | 24'].join('\n');
    expect(chunkText(table, opts())[0]?.text).toBe(table);
  });
});
