import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  decodeText,
  detectKnowledgeFile,
  normalizeText,
  parseHtml,
  parseKnowledgeFile,
  ParseError,
} from '.';

const fixture = (name: string) =>
  readFileSync(path.resolve(__dirname, '../../../../tests/fixtures/knowledge', name));

describe('knowledge parsers', () => {
  it('detects files by extension + MIME + magic bytes', () => {
    expect(detectKnowledgeFile('a.pdf', 'application/pdf', fixture('guide.pdf'))).toBe('pdf');
    expect(detectKnowledgeFile('a.docx', 'application/octet-stream', fixture('terms.docx'))).toBe(
      'docx',
    );
    expect(detectKnowledgeFile('a.TXT', 'text/plain; charset=utf-8', fixture('faq.txt'))).toBe(
      'txt',
    );
    expect(detectKnowledgeFile('a.md', 'text/markdown', fixture('policy.md'))).toBe('md');
    // mismatches
    expect(detectKnowledgeFile('a.pdf', 'application/pdf', fixture('faq.txt'))).toBeNull();
    expect(
      detectKnowledgeFile('a.docx', 'application/zip', Buffer.from('PK\u0003\u0004 not word')),
    ).toBeNull();
    expect(detectKnowledgeFile('a.txt', 'text/plain', fixture('terms.docx'))).toBeNull();
    expect(detectKnowledgeFile('a.txt', 'text/plain', Buffer.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(detectKnowledgeFile('a.txt', 'text/plain', Buffer.alloc(0))).toBeNull();
    expect(detectKnowledgeFile('a.txt', 'image/png', fixture('faq.txt'))).toBeNull();
    expect(detectKnowledgeFile('a.exe', 'application/octet-stream', fixture('faq.txt'))).toBeNull();
  });

  it('decodes UTF-8 (BOM) and Windows-1252', () => {
    expect(decodeText(Buffer.from('﻿namaste', 'utf8'))).toBe('namaste');
    expect(decodeText(fixture('windows1252.txt'))).toContain('Café policy: “No refunds');
  });

  it('normalises whitespace and control characters, keeps Devanagari', () => {
    expect(normalizeText('a\u0000b\r\n\r\n\r\n\r\nc \t  d​\n  e  ')).toBe('ab\n\nc d\ne');
    expect(normalizeText('नमस्ते  दुनिया')).toBe('नमस्ते दुनिया');
  });

  it('parses every fixture type; headings survive in DOCX', async () => {
    expect(await parseKnowledgeFile('docx', fixture('terms.docx'))).toMatch(
      /^# Loan terms\n\nThe loan tenure/,
    );
    expect(await parseKnowledgeFile('pdf', fixture('guide.pdf'))).toContain(
      'Checking your balance',
    );
    expect(await parseKnowledgeFile('txt', fixture('hindi.txt'))).toContain('भुगतान के तरीके');
  });

  it('reports unreadable / empty files', async () => {
    await expect(parseKnowledgeFile('pdf', fixture('scanned.pdf'))).rejects.toThrow(
      'No text found (scanned PDF?)',
    );
    await expect(parseKnowledgeFile('pdf', Buffer.from('%PDF-1.4 broken'))).rejects.toBeInstanceOf(
      ParseError,
    );
    await expect(parseKnowledgeFile('docx', Buffer.from('PK\u0003\u0004'))).rejects.toThrow(
      'This DOCX file could not be read.',
    );
    await expect(parseKnowledgeFile('txt', Buffer.from('  \n '))).rejects.toThrow('No text found.');
  });

  it('turns HTML into text without scripts / navigation, headings as #', () => {
    const page = parseHtml(
      '<title>FAQ</title><header>Logo</header><nav>Menu</nav><h2>Q1</h2><p>Answer <a href="https://x.example">here</a>.</p><script>x()</script><footer>Foot</footer>',
    );
    expect(page.title).toBe('FAQ');
    expect(page.text).toContain('## Q1');
    expect(page.text).toContain('Answer here.');
    for (const gone of ['Logo', 'Menu', 'x()', 'Foot', 'https://x.example'])
      expect(page.text).not.toContain(gone);
    expect(parseHtml('<p>no title</p>').title).toBeNull();
  });
});
