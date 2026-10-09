import mammoth from 'mammoth';

import { parseHtml } from './html';

/** DOCX text with headings kept as `#` lines (mammoth HTML → our HTML parser). */
export const parseDocx = async (buffer: Buffer): Promise<string> =>
  parseHtml((await mammoth.convertToHtml({ buffer })).value).text;
