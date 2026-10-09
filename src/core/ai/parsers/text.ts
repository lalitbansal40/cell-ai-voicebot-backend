const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

/** UTF-8 (BOM stripped) when valid, else Windows-1252 (old Notepad exports). */
export const decodeText = (buffer: Buffer): string => {
  const body = buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ? buffer.subarray(3)
    : buffer;
  try {
    return utf8.decode(body);
  } catch {
    return cp1252.decode(body);
  }
};

/** Control characters (except tab / newline), DEL, zero-width space and BOM. */
const isJunk = (code: number): boolean =>
  (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
  code === 0x7f ||
  code === 0x200b ||
  code === 0xfeff;

/** Removes junk characters (code-point filter — no control-character regexes). */
export const stripControl = (text: string): string =>
  Array.from(text)
    .filter((ch) => !isJunk(ch.codePointAt(0) ?? 0))
    .join('');

const SPACES = new Set([0x09, 0x20, 0xa0]);

/** Collapses tabs / spaces / no-break spaces into one space. */
const collapseSpaces = (line: string): string => {
  let out = '';
  let space = false;
  for (const ch of line) {
    if (SPACES.has(ch.codePointAt(0) ?? 0)) space = true;
    else {
      if (space && out) out += ' ';
      space = false;
      out += ch;
    }
  }
  return out;
};

/**
 * NFC, `\r\n` → `\n`, control characters removed, runs of spaces collapsed,
 * lines trimmed, at most one blank line in a row. Devanagari and other
 * scripts are untouched.
 */
export const normalizeText = (text: string): string =>
  stripControl(text.normalize('NFC').replace(/\r\n?/g, '\n'))
    .split('\n')
    .map(collapseSpaces)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
