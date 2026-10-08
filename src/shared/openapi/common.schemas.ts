import type { ZodType } from 'zod';

import { registry } from './registry';
import { z } from './zod';

/** Field-level error detail (docs/conventions/api.md §4). */
export const ErrorDetailSchema = registry.register(
  'ErrorDetail',
  z.object({
    path: z.string().openapi({ example: 'phone' }),
    message: z.string().openapi({ example: 'Must be an E.164 number' }),
  }),
);

/** Error envelope returned by every failed request (api.md §4). */
export const ErrorEnvelopeSchema = registry.register(
  'ErrorEnvelope',
  z.object({
    success: z.literal(false),
    error: z.object({
      code: z.string().openapi({ example: 'VALIDATION_FAILED' }),
      message: z.string().openapi({ example: 'Some fields are invalid.' }),
      details: z.array(ErrorDetailSchema).optional(),
      requestId: z.string().openapi({ example: 'req_8f2c1a' }),
    }),
  }),
);

/** Offset pagination meta (api.md §6). */
export const OffsetPageMetaSchema = registry.register(
  'OffsetPageMeta',
  z.object({
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
  }),
);

/** Cursor pagination meta (api.md §6). */
export const CursorPageMetaSchema = registry.register(
  'CursorPageMeta',
  z.object({
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
);

/** `{ success: true, data }` envelope around a single resource (api.md §3). */
export const successEnvelope = <T extends ZodType>(data: T) =>
  z.object({
    success: z.literal(true),
    data,
  });
