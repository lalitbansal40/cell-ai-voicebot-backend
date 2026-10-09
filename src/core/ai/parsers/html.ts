import { convert } from 'html-to-text';

/** Visible text of an HTML page — scripts, styles, navigation, header and footer dropped. */
export const parseHtml = (html: string): { text: string; title: string | null } => {
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  // headings become `#` lines so the chunker can split and title by them
  const marked = html
    .replace(/<h([1-6])\b[^>]*>/gi, (_all, level: string) => `<p>${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]>/gi, '</p>');
  const text = convert(marked, {
    wordwrap: false,
    selectors: [
      { selector: 'script', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'noscript', format: 'skip' },
      { selector: 'nav', format: 'skip' },
      { selector: 'header', format: 'skip' },
      { selector: 'footer', format: 'skip' },
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'table', format: 'dataTable' },
    ],
  });
  return { text, title: title || null };
};
