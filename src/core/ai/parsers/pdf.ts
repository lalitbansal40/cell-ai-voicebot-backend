import { extractText } from 'unpdf';

/** Text layer of every page (pages separated by a blank line). */
export const parsePdf = async (buffer: Buffer): Promise<string> => {
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: false });
  return text.join('\n\n');
};
