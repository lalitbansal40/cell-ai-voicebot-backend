import { FLOW_LIMITS } from '../../config/limits';
import { AUDIO_FORMATS } from '../../db/models/flow-audio.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

const name = z.string().trim().min(1).max(FLOW_LIMITS.nameMaxChars);

export const AudioParams = z.strictObject({ id: ObjectIdSchema });
export const ListAudioQuery = z.strictObject({ q: z.string().trim().min(1).max(80).optional() });
export const UploadAudioFields = z.strictObject({ name: name.optional() });
export const RenameAudioBody = z.strictObject({ name });

export const FlowAudioSchema = registry.register(
  'FlowAudio',
  z.object({
    id: z.string(),
    name: z.string(),
    format: z.enum(AUDIO_FORMATS),
    bytes: z.number(),
    durationMs: z.number(),
    sampleRate: z.number(),
    channels: z.number(),
    uploadedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    createdAt: z.string(),
  }),
);

export const FlowAudioUrlSchema = registry.register(
  'FlowAudioUrl',
  z.object({ url: z.string(), expiresAt: z.string() }),
);

const tags = ['Call flows'];
const read = { 401: errors[401], 403: errors[403] };
const write = { ...read, 404: errors[404], 409: errors[409], 422: errors[422] };
const base = '/api/v1/flow-audio';

registry.registerPath({
  method: 'get',
  path: base,
  tags,
  summary: 'Audio files of the account for play_audio nodes and audio prompts (flows.read)',
  security: bearer,
  request: { query: ListAudioQuery },
  responses: { 200: ok(z.array(FlowAudioSchema)), ...read },
});
registry.registerPath({
  method: 'post',
  path: base,
  tags,
  summary: `Upload one WAV / MP3 (≤ 5 MB, ≤ ${String(FLOW_LIMITS.audioMaxMs / 1000)} s, ≤ ${String(FLOW_LIMITS.audiosPerAccount)} per account, ${String(FLOW_LIMITS.audioUploadsPerHour)} uploads / h / account; flows.write)`,
  security: bearer,
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.string().openapi({ type: 'string', format: 'binary' }),
            name: name.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: ok(FlowAudioSchema, 'Created'),
    ...write,
    413: { description: 'Larger than 5 MB (PAYLOAD_TOO_LARGE)' },
    415: { description: 'Not a real WAV / MP3 file (UNSUPPORTED_MEDIA_TYPE)' },
    429: errors[429],
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/{id}/url`,
  tags,
  summary: `Short-lived signed URL (${String(FLOW_LIMITS.audioUrlTtlSec / 60)} min) to play the file`,
  security: bearer,
  request: { params: AudioParams },
  responses: { 200: ok(FlowAudioUrlSchema), ...read, 404: errors[404] },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/{id}`,
  tags,
  summary: 'Rename an audio file',
  security: bearer,
  request: {
    params: AudioParams,
    body: { content: { 'application/json': { schema: RenameAudioBody } } },
  },
  responses: { 200: ok(FlowAudioSchema), ...write },
});
registry.registerPath({
  method: 'delete',
  path: `${base}/{id}`,
  tags,
  summary:
    'Delete an audio file — 409 RESOURCE_IN_USE while a flow draft or published version uses it',
  security: bearer,
  request: { params: AudioParams },
  responses: { 204: noContentResponse, ...write },
});
