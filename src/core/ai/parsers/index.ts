import type { KnowledgeFileType } from '../../../db/models/knowledge-source.model';

import { parseDocx } from './docx';
import { parsePdf } from './pdf';
import { decodeText, normalizeText } from './text';

export { parseHtml } from './html';
export { decodeText, normalizeText, stripControl } from './text';

/** A file that can't become knowledge — the reason is shown on the source. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

const PDF_MAGIC = Buffer.from('%PDF-');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const MIME: Record<KnowledgeFileType, string[]> = {
  pdf: ['application/pdf', 'application/octet-stream'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/zip',
    'application/octet-stream',
  ],
  txt: ['text/plain', 'application/octet-stream'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream'],
};

export const KNOWLEDGE_CONTENT_TYPES: Record<KnowledgeFileType, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

/** A DOCX is a ZIP whose central directory names `word/document.xml`. */
const hasDocxEntry = (buffer: Buffer): boolean => buffer.includes('word/document.xml');

/**
 * Extension + MIME + magic bytes. `null` = unsupported (→ 415).
 * TXT / MD must not contain NUL bytes (binary files renamed to .txt).
 */
export const detectKnowledgeFile = (
  fileName: string,
  mimeType: string,
  buffer: Buffer,
): KnowledgeFileType | null => {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  const mime = mimeType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (!(ext in MIME)) return null;
  const type = ext as KnowledgeFileType;
  if (!MIME[type].includes(mime)) return null;
  const head = buffer.subarray(0, 5);
  switch (type) {
    case 'pdf':
      return head.equals(PDF_MAGIC) ? type : null;
    case 'docx':
      return head.subarray(0, 4).equals(ZIP_MAGIC) && hasDocxEntry(buffer) ? type : null;
    default:
      return buffer.length > 0 && !buffer.includes(0) && !head.subarray(0, 4).equals(ZIP_MAGIC)
        ? type
        : null;
  }
};

/** File → normalised text. Throws `ParseError` with a user-facing reason. */
export const parseKnowledgeFile = async (
  type: KnowledgeFileType,
  buffer: Buffer,
): Promise<string> => {
  let raw: string;
  try {
    raw =
      type === 'pdf'
        ? await parsePdf(buffer)
        : type === 'docx'
          ? await parseDocx(buffer)
          : decodeText(buffer);
  } catch {
    throw new ParseError(`This ${type.toUpperCase()} file could not be read.`);
  }
  const text = normalizeText(raw);
  if (!text) {
    throw new ParseError(type === 'pdf' ? 'No text found (scanned PDF?)' : 'No text found.');
  }
  return text;
};
