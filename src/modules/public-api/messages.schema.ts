import { PUBLIC_API_LIMITS } from '../../config/limits';
import { MESSAGE_STATUSES } from '../../db/models/message.model';
import { registry } from '../../shared/openapi/registry';
import { bearerOrKey, errors, ok, PUBLIC_API_TAG } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';
import { TemplateBody } from '../inbox/outbound.schema';

/** One recipient: an existing contact, or a phone number (the contact is created if needed). */
const recipient = {
  to: z.string().trim().min(5).max(40).optional().openapi({
    description: 'Phone number (E.164 or national) — creates the contact if new',
    example: '+919876543210',
  }),
  contactId: ObjectIdSchema.optional(),
  /** Defaults to the account's only connected number. */
  channelId: ObjectIdSchema.optional().openapi({
    description: 'WhatsApp number to send from — needed when the account has more than one',
  }),
  externalRef: z.string().trim().min(1).max(PUBLIC_API_LIMITS.externalRefMax).optional(),
};
const oneRecipient = (b: { to?: string | undefined; contactId?: string | undefined }) =>
  Boolean(b.to) !== Boolean(b.contactId);
const recipientIssue = { path: ['to'], message: 'Give either `to` or `contactId`' };

export const SendTemplateApiBody = z
  .strictObject({
    ...recipient,
    template: z.strictObject({
      name: z.string().trim().min(1).max(512),
      language: z.string().trim().min(2).max(20).openapi({ example: 'en' }),
    }),
    /** Values per template variable key (`{{name}}`, `{{1}}` …). */
    variables: TemplateBody.shape.variables,
    /** Location headers only (media headers need an upload — dashboard only for now). */
    header: TemplateBody.shape.header,
  })
  .refine(oneRecipient, recipientIssue);

export const SendTextApiBody = z
  .strictObject({ ...recipient, text: z.string().trim().min(1).max(4096) })
  .refine(oneRecipient, recipientIssue);

export const MessageIdParams = z.strictObject({ id: ObjectIdSchema });

export const ApiMessageSchema = registry.register(
  'ApiMessage',
  z.object({
    id: z.string(),
    conversationId: z.string(),
    contactId: z.string(),
    channelId: z.string(),
    direction: z.enum(['in', 'out']),
    type: z.string(),
    origin: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    statusHistory: z.array(z.object({ status: z.enum(MESSAGE_STATUSES), at: z.string() })),
    error: z.object({ code: z.number().nullable(), reason: z.string() }).nullable(),
    charge: z
      .object({ category: z.string(), priceMicros: z.number(), status: z.string() })
      .nullable(),
    template: z.object({ name: z.string(), language: z.string() }).nullable(),
    externalRef: z.string().nullable(),
    at: z.string(),
  }),
);

const tags = ['Messages', PUBLIC_API_TAG];
const idem = {
  headers: z.object({
    'Idempotency-Key': z.string().openapi({ description: 'Required — a retry never sends twice' }),
  }),
};

registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/template',
  tags,
  summary:
    'Send an approved template to a contact or phone (inbox.reply / messages:write) — works outside the 24-hour window; charged like the dashboard (hold, marketing limits, opt-out, DND)',
  security: bearerOrKey,
  request: { ...idem, body: { content: { 'application/json': { schema: SendTemplateApiBody } } } },
  responses: {
    201: ok(ApiMessageSchema, 'Queued'),
    200: ok(ApiMessageSchema, 'Already sent with this Idempotency-Key'),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/v1/messages/text',
  tags,
  summary:
    'Send a text inside the 24-hour window (else 409 WHATSAPP_WINDOW_CLOSED — send a template)',
  security: bearerOrKey,
  request: { ...idem, body: { content: { 'application/json': { schema: SendTextApiBody } } } },
  responses: {
    201: ok(ApiMessageSchema, 'Queued'),
    403: errors[403],
    404: errors[404],
    409: errors[409],
    422: errors[422],
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/messages/{id}',
  tags,
  summary:
    'One WhatsApp message: status history, error, charge, externalRef (inbox.read / messages:read)',
  security: bearerOrKey,
  request: { params: MessageIdParams },
  responses: { 200: ok(ApiMessageSchema), 403: errors[403], 404: errors[404] },
});
