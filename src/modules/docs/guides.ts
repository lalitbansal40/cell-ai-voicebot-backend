import { GUIDE_FILES } from './guides.gen';

/** The hand-written guides (`docs/api/*.md`), in reading order — `npm run gen:guides` copies them. */
export const GUIDE_ORDER = [
  'getting-started',
  'authentication',
  'conventions',
  'errors',
  'idempotency',
  'rate-limits',
  'pagination',
  'whatsapp-messages',
  'calls',
  'whatsapp-calls',
  'campaigns',
  'reports-exports',
  'webhooks',
  'versioning',
  'troubleshooting',
  'changelog',
] as const;

/** One heading level down, so every guide sits under the page title in Swagger UI. */
const demote = (markdown: string): string =>
  markdown.replace(/^(#{1,5}) /gm, (_m, hashes: string) => `${hashes}# `);

/** All guides as one Markdown text (Swagger UI renders `info.description` as Markdown). */
export const guidesMarkdown = (): string =>
  GUIDE_ORDER.map((name) => demote(GUIDE_FILES[name] ?? '')).join('\n\n---\n\n');
