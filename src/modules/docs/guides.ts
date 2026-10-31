import { GUIDE_FILES } from './guides.gen';

/** The hand-written guides (`docs/api/*.md`), in reading order — `npm run gen:guides` copies them. */
export const GUIDE_ORDER = [
  'getting-started',
  'errors',
  'idempotency',
  'rate-limits',
  'pagination',
  'webhooks',
  'changelog',
] as const;

/** One heading level down, so every guide sits under the page title in Swagger UI. */
const demote = (markdown: string): string =>
  markdown.replace(/^(#{1,5}) /gm, (_m, hashes: string) => `${hashes}# `);

/** All guides as one Markdown text (Swagger UI renders `info.description` as Markdown). */
export const guidesMarkdown = (): string =>
  GUIDE_ORDER.map((name) => demote(GUIDE_FILES[name] ?? '')).join('\n\n---\n\n');
