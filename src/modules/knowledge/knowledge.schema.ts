import { AI_LIMITS } from '../../config/limits';
import {
  KNOWLEDGE_FILE_TYPES,
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_SOURCE_STATUSES,
} from '../../db/models/knowledge-source.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

const text = (max: number) => z.string().trim().max(max);

export const KbParams = z.strictObject({ id: ObjectIdSchema });
export const SourceParams = z.strictObject({ id: ObjectIdSchema, sid: ObjectIdSchema });

export const CreateKbBody = z.strictObject({
  name: text(80).min(1),
  description: text(300).nullable().optional(),
});

export const UpdateKbBody = z
  .strictObject({ name: text(80).min(1), description: text(300).nullable() })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

export const DeleteKbQuery = z.strictObject({
  force: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const AddUrlBody = z.strictObject({
  url: z.string().trim().min(1).max(2000),
  title: text(200).min(1).optional(),
});

export const SearchKbBody = z.strictObject({
  query: text(500).min(1),
  topK: z.number().int().min(1).max(8).default(4),
  minScoreHundredths: z.number().int().min(0).max(100).default(0),
});

// ── Responses ─────────────────────────────────────────────────────────────

export const KnowledgeBaseSchema = registry.register(
  'KnowledgeBase',
  z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    sourcesCount: z.number(),
    chunksCount: z.number(),
    status: z
      .enum(['ok', 'stale'])
      .openapi({ description: '`stale` when the embedding model changed — re-index' }),
    embeddingModel: z.string().nullable(),
    linkedAgents: z.array(z.object({ id: z.string(), name: z.string() })),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const KnowledgeSourceSchema = registry.register(
  'KnowledgeSource',
  z.object({
    id: z.string(),
    kbId: z.string(),
    kind: z.enum(KNOWLEDGE_SOURCE_KINDS),
    title: z.string(),
    fileType: z.enum(KNOWLEDGE_FILE_TYPES).nullable(),
    url: z.string().nullable(),
    bytes: z.number(),
    chars: z.number(),
    chunks: z.number(),
    status: z.enum(KNOWLEDGE_SOURCE_STATUSES),
    progress: z.number().openapi({ description: '0–100' }),
    error: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const KnowledgeHitSchema = registry.register(
  'KnowledgeHit',
  z.object({
    chunkId: z.string(),
    sourceId: z.string(),
    sourceTitle: z.string(),
    title: z.string(),
    text: z.string(),
    score: z.number().openapi({ description: 'Cosine similarity (+0.05 keyword boost), 0–1' }),
  }),
);

// ── OpenAPI paths ─────────────────────────────────────────────────────────

const tags = ['Knowledge bases'];
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});
const read = { 401: errors[401], 403: errors[403] };
const write = { ...read, 404: errors[404], 409: errors[409], 422: errors[422] };
const byId = { params: KbParams };
const bySource = { params: SourceParams };
const base = '/api/v1/knowledge-bases';

registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Knowledge bases of the account (agents.read)',
  security: bearer,
  responses: { 200: ok(z.array(KnowledgeBaseSchema)), ...read },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary: `Create a knowledge base (≤ ${AI_LIMITS.kbPerAccount} per account; agents.write)`,
  security: bearer,
  request: json(CreateKbBody),
  responses: { 201: ok(KnowledgeBaseSchema, 'Created'), ...write },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}`,
  tags,
  summary: 'One knowledge base',
  security: bearer,
  request: byId,
  responses: { 200: ok(KnowledgeBaseSchema), ...read, 404: errors[404] },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}`,
  tags,
  summary: 'Rename / describe a knowledge base',
  security: bearer,
  request: { ...byId, ...json(UpdateKbBody) },
  responses: { 200: ok(KnowledgeBaseSchema), ...write },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary:
    'Delete a knowledge base with its files and chunks — 409 while agents use it unless `force=true` (unlinks them)',
  security: bearer,
  request: { ...byId, query: DeleteKbQuery },
  responses: { 204: noContentResponse, ...write },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/sources`,
  tags,
  summary: 'Files and pages of a knowledge base',
  security: bearer,
  request: byId,
  responses: { 200: ok(z.array(KnowledgeSourceSchema)), ...read, 404: errors[404] },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/sources/files`,
  tags,
  summary: `Upload 1–${AI_LIMITS.filesPerUpload} PDF / DOCX / TXT / MD files (≤ 10 MB each, ≤ ${AI_LIMITS.sourcesPerKb} sources per base, ${AI_LIMITS.kbSourcesPerHour} adds / h / account) — processed in the background`,
  security: bearer,
  request: {
    ...byId,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            files: z.array(z.string().openapi({ type: 'string', format: 'binary' })),
          }),
        },
      },
    },
  },
  responses: {
    202: ok(z.array(KnowledgeSourceSchema), 'Queued'),
    ...write,
    413: { description: 'A file is larger than 10 MB (PAYLOAD_TOO_LARGE)' },
    415: { description: 'Not a real PDF / DOCX / TXT / MD file (UNSUPPORTED_MEDIA_TYPE)' },
    429: errors[429],
  },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/sources/url`,
  tags,
  summary:
    'Add one public web page (fetched in the background, ≤ 2 MB, html / plain text; same address rules as functions → FUNCTION_URL_BLOCKED)',
  security: bearer,
  request: { ...byId, ...json(AddUrlBody) },
  responses: { 202: ok(KnowledgeSourceSchema, 'Queued'), ...write, 429: errors[429] },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}/sources/{sid}`,
  tags,
  summary: 'Remove a source with its file and chunks',
  security: bearer,
  request: bySource,
  responses: { 204: noContentResponse, ...write },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/sources/{sid}/reindex`,
  tags,
  summary: 'Process one source again',
  security: bearer,
  request: bySource,
  responses: { 202: ok(KnowledgeSourceSchema, 'Queued'), ...write },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/reindex`,
  tags,
  summary: 'Process every source again (e.g. after an embedding model change)',
  security: bearer,
  request: byId,
  responses: { 202: ok(z.array(KnowledgeSourceSchema), 'Queued'), ...write },
});
registry.registerPath({
  method: 'post',
  path: `${base}/{id}/search`,
  tags,
  summary: 'Try a question — best matching chunks with scores (agents.read; no charge)',
  security: bearer,
  request: { ...byId, ...json(SearchKbBody) },
  responses: { 200: ok(z.array(KnowledgeHitSchema)), ...read, 404: errors[404], 422: errors[422] },
});
