import { TEMPLATE_LIMITS } from '../../config/limits';
import {
  PARAMETER_FORMATS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_PURPOSES,
  TEMPLATE_QUALITY,
  TEMPLATE_STATUSES,
  VARIABLE_COMPONENTS,
  VARIABLE_SOURCES,
} from '../../db/models/whatsapp-template.model';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

/** Meta component JSON (validated in depth by `validateTemplate`, one error per path). */
const Components = z
  .array(z.looseObject({ type: z.string().min(1).max(60) }))
  .min(1)
  .max(6)
  .openapi({ description: 'Meta template components (HEADER / BODY / FOOTER / BUTTONS)' });

const name = z.string().trim().min(1).max(TEMPLATE_LIMITS.nameMax);
const language = z.string().trim().min(2).max(20);
const ttl = z
  .number()
  .int()
  .min(30)
  .max(30 * 86_400)
  .nullable();

export const TemplateParams = z.object({ id: ObjectIdSchema });

const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)));

export const ListTemplatesQuery = z.object({
  channelId: ObjectIdSchema.optional(),
  status: csv(TEMPLATE_STATUSES).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).optional(),
  purpose: z.enum(TEMPLATE_PURPOSES).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  includeDeleted: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const CreateTemplateBody = z
  .object({
    channelId: ObjectIdSchema,
    name,
    language,
    category: z.enum(TEMPLATE_CATEGORIES),
    parameterFormat: z.enum(PARAMETER_FORMATS).optional(),
    components: Components,
    ttlSeconds: ttl.optional(),
    /** `false` keeps a draft (e.g. to upload a media header example first). */
    submit: z.boolean().optional(),
  })
  .openapi('WhatsAppTemplateCreate');

export const EditTemplateBody = z
  .object({
    name: name.optional(),
    language: language.optional(),
    category: z.enum(TEMPLATE_CATEGORIES).optional(),
    parameterFormat: z.enum(PARAMETER_FORMATS).optional(),
    components: Components.optional(),
    ttlSeconds: ttl.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Nothing to update')
  .openapi('WhatsAppTemplateEdit');

export const DeleteTemplateQuery = z.object({
  /** `language` = this language only; `name` = every language of the name. */
  scope: z.enum(['language', 'name']).default('language'),
});

export const SyncTemplatesBody = z.object({ channelId: ObjectIdSchema });

export const CallPermissionBody = z
  .object({
    channelId: ObjectIdSchema,
    language: language.optional(),
    body: z.string().trim().min(1).max(TEMPLATE_LIMITS.bodyMax).optional(),
    submit: z.boolean().optional(),
  })
  .openapi('WhatsAppCallPermissionTemplate');

export const VariableSourcesBody = z
  .object({
    sources: z
      .array(
        z.object({
          key: z.string().min(1).max(60),
          kind: z.enum(VARIABLE_SOURCES),
          value: z.string().max(TEMPLATE_LIMITS.variableValueMax).nullable().optional(),
        }),
      )
      .min(1)
      .max(TEMPLATE_LIMITS.variablesMax),
  })
  .openapi('WhatsAppTemplateVariableSources');

const iso = z.string().nullable();
const usage = z.object({
  sent: z.number(),
  delivered: z.number(),
  read: z.number(),
  failed: z.number(),
  lastSentAt: iso,
});
const reason = z
  .object({ reason: z.string(), title: z.string().nullable(), description: z.string().nullable() })
  .nullable();

export const TemplateListItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    language: z.string(),
    category: z.enum(TEMPLATE_CATEGORIES),
    previousCategory: z.enum(TEMPLATE_CATEGORIES).nullable(),
    status: z.enum(TEMPLATE_STATUSES),
    statusReason: reason,
    quality: z.enum(TEMPLATE_QUALITY).nullable(),
    pausedUntil: iso,
    purpose: z.enum(TEMPLATE_PURPOSES),
    editable: z.boolean(),
    parameterFormat: z.enum(PARAMETER_FORMATS),
    channelIds: z.array(z.string()),
    variablesCount: z.number(),
    submitted: z.boolean(),
    usage,
    syncedAt: iso,
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('WhatsAppTemplateListItem');

export const TemplateDetailSchema = TemplateListItemSchema.extend({
  subCategory: z.string().nullable(),
  components: z.array(z.looseObject({ type: z.string() })),
  variables: z.array(
    z.object({
      key: z.string(),
      component: z.enum(VARIABLE_COMPONENTS),
      index: z.number(),
      example: z.string(),
      defaultSource: z.object({ kind: z.enum(VARIABLE_SOURCES), value: z.string().nullable() }),
    }),
  ),
  statusHistory: z.array(
    z.object({
      status: z.enum(TEMPLATE_STATUSES),
      reason: z.string().nullable(),
      at: z.string(),
      source: z.enum(['user', 'webhook', 'sync']),
    }),
  ),
  ttlSeconds: z.number().nullable(),
  headerMedia: z
    .object({
      mimeType: z.string(),
      size: z.number(),
      fileName: z.string().nullable(),
      uploaded: z.boolean(),
    })
    .nullable(),
  editsLast30Days: z.number(),
  nextEditAt: iso,
  deletedAt: iso,
  createdBy: z.string().nullable(),
}).openapi('WhatsAppTemplate');

export const SyncResultSchema = z
  .object({ created: z.number(), updated: z.number(), deleted: z.number(), unchanged: z.number() })
  .openapi('WhatsAppTemplateSyncResult');
