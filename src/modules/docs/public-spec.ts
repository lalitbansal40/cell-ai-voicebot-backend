import { guidesMarkdown } from './guides';
import { PUBLIC_DOCS } from './public-docs';
import { PUBLIC_TAG_ORDER } from './quality';
import { sampleFor } from './sample';

/** Routes open to API keys carry this tag (the docs page shows only these in production). */
export const PUBLIC_API_TAG = 'Public API';

type Json = Record<string, unknown>;
type Operation = { tags?: string[] } & Json;
export interface OpenApiDoc {
  info: Json;
  paths: Record<string, Record<string, unknown>>;
  tags?: { name: string }[];
  components?: { schemas?: Record<string, unknown> } & Json;
  [key: string]: unknown;
}

const METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** One line per area of the public docs (L7). */
export const PUBLIC_TAG_DESCRIPTIONS: Record<(typeof PUBLIC_TAG_ORDER)[number], string> = {
  'Getting started': 'Check your API key.',
  'Account resources':
    'Ids of flows, AI agents, WhatsApp numbers, lists, segments, caller numbers, IVRs, and the wallet balance.',
  Contacts: 'Create, update, upsert and read contacts.',
  'WhatsApp messages': 'Send approved templates and texts; read their status.',
  'WhatsApp templates': 'Templates you can send.',
  Calls: 'Phone calls with a flow or AI agent; results, transcripts and AI insights.',
  'WhatsApp calls': 'WhatsApp calls with an AI agent or flow.',
  Campaigns: 'Call campaigns: phone (SIP / test line), WhatsApp calls and recorded voice / IVR.',
  'WhatsApp bulk campaigns': 'Send approved templates to many contacts.',
  Reports: 'Report numbers by date range.',
  Exports: 'CSV / XLSX exports of calls, messages and reports.',
  Webhooks: 'Signed events to your server.',
};

const ERROR_TEXT: Record<string, string> = {
  '401': 'Missing, wrong, expired or revoked API key (AUTH_UNAUTHENTICATED)',
  '403':
    'The key lacks the scope (`details[0].path = scope`), IP not allowed, or the account is suspended (AUTH_FORBIDDEN)',
  '404': "Not found in this account (RESOURCE_NOT_FOUND) — other accounts' ids always answer 404",
  '422': 'Validation failed (VALIDATION_FAILED); `details` lists each field path and message',
  '429': 'Rate limited (RATE_LIMITED) — wait `Retry-After` seconds',
  '503':
    'Busy or a provider is down (CALL_CAPACITY, PROVIDER_UNAVAILABLE) — retry later with the same Idempotency-Key',
};
const errorResponse = (code: string) => ({
  description: ERROR_TEXT[code] ?? 'Error',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
});

type Content = Record<string, { schema?: unknown; example?: unknown; examples?: unknown }>;
type FullOp = Operation & {
  operationId?: string;
  description?: string;
  requestBody?: { content?: Content };
  responses?: Record<string, { content?: Content } & Json>;
};

/** Fills the docs of one public operation (L5): id, area, scope, description, examples, errors. */
const documentOp = (
  method: string,
  path: string,
  op: FullOp,
  components: Record<string, unknown>,
): FullOp => {
  const docs = PUBLIC_DOCS[`${method.toUpperCase()} ${path}`];
  const next: FullOp = { ...op };
  if (docs) {
    next.operationId = docs.operationId;
    next.description = docs.description;
    next.tags = [PUBLIC_API_TAG, docs.area];
    if (docs.scope) next['x-scope'] = docs.scope;
  }
  const body = next.requestBody?.content;
  if (body) {
    const content: Content = {};
    for (const [type, media] of Object.entries(body)) {
      content[type] =
        media.example !== undefined || media.examples !== undefined
          ? media
          : docs?.requestExamples
            ? { ...media, examples: docs.requestExamples }
            : { ...media, example: docs?.request ?? sampleFor(media.schema, components) };
    }
    next.requestBody = { ...next.requestBody, content };
  }
  const responses: NonNullable<FullOp['responses']> = {};
  for (const [code, response] of Object.entries(next.responses ?? {})) {
    if (!/^2\d\d$/.test(code) || !response.content) {
      responses[code] = response;
      continue;
    }
    const content: Content = {};
    for (const [type, media] of Object.entries(response.content)) {
      content[type] =
        media.example !== undefined || media.examples !== undefined
          ? media
          : { ...media, example: sampleFor(media.schema, components) };
    }
    responses[code] = { ...response, content };
  }
  for (const code of [
    '401',
    '403',
    '422',
    '429',
    ...(path.includes('{') ? ['404'] : []),
    ...(docs?.errors ?? []),
  ]) {
    responses[code] ??= errorResponse(code);
  }
  next.responses = responses;
  return next;
};

const refsIn = (value: unknown, out: Set<string>): Set<string> => {
  if (Array.isArray(value)) for (const v of value) refsIn(v, out);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '$ref' && typeof v === 'string' && v.startsWith('#/components/schemas/'))
        out.add(v.slice('#/components/schemas/'.length));
      else refsIn(v, out);
    }
  }
  return out;
};

/**
 * The public docs (ADR 0045, plan §7 #6): only operations tagged `Public API`,
 * only the schemas they reach, and the hand-written guides as the description.
 * Dashboard-only routes and their schemas never appear.
 */
export const buildPublicSpec = (full: OpenApiDoc): OpenApiDoc => {
  const paths: OpenApiDoc['paths'] = {};
  for (const [path, item] of Object.entries(full.paths)) {
    const kept = Object.fromEntries(
      Object.entries(item)
        .filter(
          ([method, op]) =>
            METHODS.has(method) && ((op as Operation).tags ?? []).includes(PUBLIC_API_TAG),
        )
        .map(([method, op]) => [
          method,
          documentOp(method, path, op as FullOp, full.components?.schemas ?? {}),
        ]),
    );
    if (Object.keys(kept).length) paths[path] = kept;
  }
  const schemas = full.components?.schemas ?? {};
  const keep = refsIn(paths, new Set<string>());
  // follow refs inside the kept schemas until nothing new appears
  for (let grew = true; grew;) {
    grew = false;
    for (const name of [...keep]) {
      for (const ref of refsIn(schemas[name], new Set<string>())) {
        if (!keep.has(ref)) {
          keep.add(ref);
          grew = true;
        }
      }
    }
  }
  const usedTags = new Set(
    Object.values(paths).flatMap((item) =>
      Object.values(item).flatMap((op) => (op as Operation).tags ?? []),
    ),
  );
  const securitySchemes = (full.components?.securitySchemes ?? {}) as Record<string, Json>;
  return {
    ...full,
    info: { ...full.info, title: 'NotifyNow API', description: guidesMarkdown() },
    // this server's origin (APP_URL); every path already starts with /api/v1
    servers: full.servers,
    externalDocs: { description: 'Guides and reference', url: '/api/docs' },
    paths,
    tags: PUBLIC_TAG_ORDER.filter((t) => usedTags.has(t)).map((name) => ({
      name,
      description: PUBLIC_TAG_DESCRIPTIONS[name],
    })),
    components: {
      ...full.components,
      securitySchemes: {
        ...securitySchemes,
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description:
            'Your API key (`cav_live_…`) from Settings → API keys (owners and admins). Each route needs one scope (`x-scope`); the key is shown once — keep it on your server.',
        },
      },
      schemas: Object.fromEntries(Object.entries(schemas).filter(([name]) => keep.has(name))),
    },
  };
};
