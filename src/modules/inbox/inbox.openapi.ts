import { INBOX_LIMITS } from '../../config/limits';
import { BUSINESS_VERTICALS } from '../../core/meta';
import { INBOX_NOTIFY_MODES } from '../../db/models/account.model';
import { CONVERSATION_SOURCES, CONVERSATION_STATUSES } from '../../db/models/conversation.model';
import { UPLOAD_KINDS } from '../../db/models/inbox-upload.model';
import {
  INTERACTIVE_HEADER_TYPES,
  INTERACTIVE_KINDS,
  MEDIA_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_ORIGINS,
  MESSAGE_STATUSES,
  MESSAGE_TYPES,
  REACTION_ACTORS,
  MESSAGE_BILLING_STATUSES,
  MESSAGE_PAYERS,
} from '../../db/models/message.model';
import { CALL_PERMISSION_STATUSES } from '../../db/models/whatsapp-call-permission.model';
import { WA_CHANNEL_STATUSES, WA_MODES } from '../../db/models/whatsapp-channel.model';
import { TEMPLATE_CATEGORIES } from '../../db/models/whatsapp-template.model';
import { registry } from '../../shared/openapi/registry';
import { bearer, errors, noContentResponse, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';
import { ChannelParams } from '../whatsapp/whatsapp.schema';

import {
  AssignBody,
  BusinessProfilePatchBody,
  ConversationParams,
  InboxSettingsPatchBody,
  ListConversationsQuery,
  ListMessagesQuery,
  MessageParams,
  StartConversationBody,
} from './inbox.schema';
import { SendMessageBody } from './outbound.schema';

const iso = z.string().nullable();
const s = z.string().nullable();

export const InboxMessageSchema = registry.register(
  'InboxMessage',
  z.object({
    id: z.string(),
    conversationId: z.string(),
    channelId: z.string(),
    direction: z.enum(MESSAGE_DIRECTIONS),
    origin: z.enum(MESSAGE_ORIGINS).openapi({
      description:
        '`business_app` = sent from the WhatsApp Business app (coexistence); `history` = imported',
    }),
    type: z.enum(MESSAGE_TYPES).openapi({ description: '`note` = internal team note, never sent' }),
    text: s.openapi({ description: 'Body / caption (customer data)' }),
    media: z
      .object({
        status: z.enum(MEDIA_STATUSES),
        mimeType: s,
        size: z.number().nullable(),
        fileName: s,
        durationSec: z.number().nullable(),
        voice: z.boolean(),
        animated: z.boolean(),
      })
      .nullable()
      .openapi({ description: 'Fetch the file with GET /inbox/messages/{id}/media' }),
    location: z
      .object({ latitude: z.number(), longitude: z.number(), name: s, address: s, url: s })
      .nullable(),
    contacts: z
      .array(
        z.object({
          name: z.string(),
          phones: z.array(z.object({ phone: z.string(), type: s, waId: s })),
          emails: z.array(z.object({ email: z.string(), type: s })),
          org: s,
        }),
      )
      .nullable(),
    interactive: z
      .object({
        kind: z.enum(INTERACTIVE_KINDS),
        header: z
          .object({ type: z.enum(INTERACTIVE_HEADER_TYPES), text: s, fileName: s })
          .nullable(),
        body: s,
        footer: s,
        buttons: z.array(z.object({ id: z.string(), title: z.string() })),
        listButton: s,
        sections: z.array(
          z.object({
            title: s,
            rows: z.array(z.object({ id: z.string(), title: z.string(), description: s })),
          }),
        ),
        cta: z.object({ displayText: z.string(), url: z.string() }).nullable(),
        reply: z.object({ id: s, title: s, description: s }).nullable(),
        nfmResponse: s,
        nfmTruncated: z.boolean(),
        callPermission: z
          .object({
            response: z.enum(['accept', 'reject']),
            isPermanent: z.boolean(),
            expiresAt: z.string().nullable(),
            source: z.string().nullable(),
          })
          .nullable()
          .openapi({ description: 'Phase 12: a permission reply / the answer on a request' }),
        voiceCall: z
          .object({ displayText: z.string(), ttlMinutes: z.number().nullable() })
          .nullable(),
        requestState: z
          .enum(['sent', 'answered', 'expired', 'failed'])
          .nullable()
          .openapi({ description: 'Call permission request bubbles only' }),
      })
      .nullable(),
    reaction: z.object({ targetMessageId: s, emoji: z.string() }).nullable(),
    context: z
      .object({
        replyToMessageId: s,
        forwarded: z.boolean(),
        frequentlyForwarded: z.boolean(),
        referral: z
          .object({ sourceUrl: s, sourceType: s, sourceId: s, headline: s, body: s, ctwaClid: s })
          .nullable(),
      })
      .nullable(),
    call: z
      .object({
        callId: z.string(),
        direction: z.enum(['in', 'out']),
        outcome: z.enum(['missed', 'completed', 'rejected', 'failed', 'no_answer']),
        durationSec: z.number(),
        mode: z.enum(['ai', 'human']),
      })
      .nullable()
      .openapi({ description: 'Phase 12: the WhatsApp call bubble (`type: call`)' }),
    replyTo: z
      .object({
        id: z.string(),
        type: z.enum(MESSAGE_TYPES),
        direction: z.enum(MESSAGE_DIRECTIONS),
        preview: z.string(),
      })
      .nullable(),
    reactions: z.array(
      z.object({ emoji: z.string(), by: z.enum(REACTION_ACTORS), at: z.string() }),
    ),
    order: z
      .object({ catalogId: s, itemsCount: z.number(), total: z.number().nullable(), currency: s })
      .nullable(),
    button: z.object({ payload: s, text: s }).nullable(),
    system: z.object({ kind: z.string(), newWaIdLast4: s }).nullable(),
    status: z.enum(MESSAGE_STATUSES),
    statusHistory: z.array(z.object({ status: z.enum(MESSAGE_STATUSES), at: z.string() })),
    error: z.object({ code: z.number().nullable(), reason: z.string() }).nullable(),
    clientId: s,
    sentBy: z.object({ id: z.string(), name: z.string() }).nullable(),
    retryOf: s,
    template: z
      .object({
        templateId: z.string(),
        name: z.string(),
        language: z.string(),
        category: z.enum(TEMPLATE_CATEGORIES),
      })
      .nullable(),
    billing: z
      .object({
        payer: z.enum(MESSAGE_PAYERS),
        category: z.string(),
        market: z.string(),
        priceMicros: z.number().int(),
        status: z.enum(MESSAGE_BILLING_STATUSES),
      })
      .nullable(),
    at: z.string(),
    createdAt: z.string(),
  }),
);

export const InboxConversationSchema = registry.register(
  'InboxConversation',
  z.object({
    id: z.string(),
    channelId: z.string(),
    contact: z.object({
      id: z.string(),
      name: s,
      phoneE164: z.string(),
      deleted: z.boolean(),
      optedOut: z.boolean(),
    }),
    label: z.string().openapi({ description: 'Contact name or the masked number' }),
    phoneE164: z.string(),
    profileName: s,
    status: z.enum(CONVERSATION_STATUSES),
    assignedTo: z.object({ id: z.string(), name: z.string() }).nullable(),
    unreadCount: z.number().int(),
    lastMessage: z
      .object({
        id: z.string(),
        direction: z.enum(MESSAGE_DIRECTIONS),
        type: z.enum(MESSAGE_TYPES),
        preview: z.string(),
        at: z.string(),
        status: z.enum(MESSAGE_STATUSES),
      })
      .nullable(),
    windowExpiresAt: iso.openapi({ description: '24-hour customer service window end' }),
    windowOpen: z.boolean(),
    blocked: z.boolean(),
    source: z.enum(CONVERSATION_SOURCES),
    closedAt: iso,
    createdAt: z.string(),
    match: z.object({ messageId: z.string(), snippet: z.string() }).nullable().optional(),
  }),
);

const InboxConversationDetailSchema = registry.register(
  'InboxConversationDetail',
  InboxConversationSchema.extend({
    channel: z
      .object({
        id: z.string(),
        label: z.string(),
        displayPhoneNumber: s,
        status: z.enum(WA_CHANNEL_STATUSES),
        mode: z.enum(WA_MODES),
      })
      .nullable(),
    lastReadAt: iso,
    created: z.boolean().optional(),
  }),
);

const ContactPanelSchema = registry.register(
  'InboxContactPanel',
  z.object({
    contact: z
      .object({
        id: z.string(),
        name: s,
        phoneE164: z.string(),
        email: s,
        tags: z.array(z.string()),
        lists: z.array(z.object({ id: z.string(), name: z.string() })),
        variables: z.record(z.string(), z.unknown()),
        dnd: z.boolean(),
        optedOutAt: iso,
        deleted: z.boolean(),
        whatsapp: z.object({ profileName: s, lastInboundAt: iso, blocked: z.boolean() }).nullable(),
      })
      .nullable(),
    recentCalls: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        at: z.string(),
        durationSec: z.number().nullable(),
        disposition: s,
      }),
    ),
    callPermission: z
      .object({
        status: z.enum(CALL_PERMISSION_STATUSES),
        expiresAt: z.string().nullable(),
        canCall: z.boolean(),
        canRequest: z.boolean(),
        nextRequestAt: z.string().nullable(),
        reason: z.string().nullable().openapi({
          description:
            'Why not: not_connected / calling_disabled / calling_unavailable / country / restricted / dnd / opted_out / blocked / check_failed / no_permission / call_limit',
        }),
      })
      .nullable()
      .openapi({ description: 'WhatsApp call permission on this number (Phase 12)' }),
    otherConversations: z.array(
      z.object({
        id: z.string(),
        channelId: z.string(),
        channelLabel: z.string(),
        lastMessageAt: iso,
        status: z.enum(CONVERSATION_STATUSES),
      }),
    ),
  }),
);

const SummarySchema = registry.register(
  'InboxSummary',
  z.object({
    unreadConversations: z.number().int(),
    assignedToMeUnread: z.number().int(),
    open: z.number().int(),
  }),
);

const UploadResultSchema = registry.register(
  'InboxUpload',
  z.object({
    mediaToken: z
      .string()
      .openapi({ description: 'Send it as `mediaToken` (this user, 24 h, once)' }),
    kind: z.enum(UPLOAD_KINDS),
    mimeType: z.string(),
    size: z.number().int(),
    fileName: s,
    durationSec: z.number().nullable(),
    voice: z
      .boolean()
      .openapi({ description: 'A voice note (mono OGG / Opus); false = sent as an audio file' }),
    expiresAt: z.string(),
  }),
);

const InboxSettingsSchema = registry.register(
  'InboxSettings',
  z.object({
    sendReadReceipts: z.boolean(),
    optOutKeywords: z.array(z.string()),
    optInKeywords: z.array(z.string()),
    optOutReply: z.boolean(),
    optOutReplyText: z.string(),
    optInReply: z.boolean(),
    optInReplyText: z.string(),
    notifyOnNewMessage: z.enum(INBOX_NOTIFY_MODES),
    retentionDays: z
      .number()
      .int()
      .openapi({ description: 'Messages are kept this many days (0 = forever); platform setting' }),
  }),
);

const BusinessProfileSchema = registry.register(
  'WhatsAppBusinessProfile',
  z.object({
    about: s,
    address: s,
    description: s,
    email: s,
    profilePictureUrl: s,
    websites: z.array(z.string()),
    vertical: s.openapi({ description: `One of ${BUSINESS_VERTICALS.join(', ')}` }),
  }),
);

const InboxConfigSchema = registry.register(
  'InboxConfig',
  z.object({
    retentionDays: z.number().int(),
    fakeProvider: z.boolean(),
    limits: z.record(z.string(), z.number()),
  }),
);

const page = <T extends z.ZodType>(item: T, meta: z.ZodType) => ({
  description: 'OK',
  content: {
    'application/json': {
      schema: z.object({ success: z.literal(true), data: z.array(item), meta }),
    },
  },
});
const multipart = (fields: Record<string, z.ZodType>) => ({
  body: {
    content: {
      'multipart/form-data': {
        schema: z.object({ ...fields, file: z.string().openapi({ format: 'binary' }) }),
      },
    },
  },
});
const json = <T extends z.ZodType>(schema: T) => ({
  body: { content: { 'application/json': { schema } } },
});

const tags = ['Inbox'];
const base = '/api/v1/inbox';
const notSetUp = {
  503: { description: "WhatsApp isn't set up on this server (WHATSAPP_NOT_CONFIGURED)" },
};
const common = { 401: errors[401], 403: errors[403], 404: errors[404], ...notSetUp };
const writes = { ...common, 409: errors[409], 422: errors[422], 429: errors[429] };

registry.registerPath({
  method: 'get',
  path: `${base}/config`,
  tags,
  summary: 'Composer limits, message retention days, fake provider flag (inbox.read)',
  security: bearer,
  responses: { 200: ok(InboxConfigSchema), ...common },
});
registry.registerPath({
  method: 'get',
  path: `${base}/summary`,
  tags,
  summary: 'Unread / mine / open counts for the nav badge and dashboard (inbox.read)',
  security: bearer,
  responses: { 200: ok(SummarySchema), ...common },
});
registry.registerPath({
  method: 'get',
  path: `${base}/conversations`,
  tags,
  summary: 'Conversations, newest first (inbox.read)',
  description:
    'Filters: status (open / closed), filter (unread / mine / unassigned), channelId; `q` (≥ 2 chars) searches contact names / numbers and message text (`match` = the hit). Cursor pagination: pass `meta.nextCursor`.',
  security: bearer,
  request: { query: ListConversationsQuery },
  responses: { 200: page(InboxConversationSchema, z.object({ nextCursor: s })), ...common },
});
registry.registerPath({
  method: 'post',
  path: `${base}/conversations/start`,
  tags,
  summary: 'Open (or create) the conversation of a contact on a number (inbox.reply)',
  security: bearer,
  request: json(StartConversationBody),
  responses: {
    200: ok(InboxConversationDetailSchema),
    201: ok(InboxConversationDetailSchema, 'Created'),
    ...writes,
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/conversations/{id}`,
  tags,
  summary: 'Conversation detail incl. the 24-hour window and the number (inbox.read)',
  security: bearer,
  request: { params: ConversationParams },
  responses: { 200: ok(InboxConversationDetailSchema), ...common },
});
registry.registerPath({
  method: 'get',
  path: `${base}/conversations/{id}/messages`,
  tags,
  summary: 'Messages oldest → newest (inbox.read)',
  description:
    '`before` = `meta.olderCursor` of the previous page; `around` = a message id (jump to a quoted message).',
  security: bearer,
  request: { params: ConversationParams, query: ListMessagesQuery },
  responses: {
    200: page(InboxMessageSchema, z.object({ olderCursor: s, hasNewer: z.boolean() })),
    ...common,
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/conversations/{id}/contact`,
  tags,
  summary: 'Contact panel: contact, recent calls, other conversations (inbox.read)',
  security: bearer,
  request: { params: ConversationParams },
  responses: { 200: ok(ContactPanelSchema), ...common },
});
registry.registerPath({
  method: 'post',
  path: `${base}/conversations/{id}/messages`,
  tags,
  summary: `Send a message or write an internal note (inbox.reply; ${String(INBOX_LIMITS.sendsPerMinutePerUser)} / min / user)`,
  description:
    'Idempotent by `clientId` (a retry returns the same message, 200). Free-form messages need the 24-hour window (409 WHATSAPP_WINDOW_CLOSED); notes never leave the app. Media types reference an upload (`mediaToken`).',
  security: bearer,
  request: { params: ConversationParams, ...json(SendMessageBody) },
  responses: {
    200: ok(InboxMessageSchema, 'Already sent (same clientId)'),
    201: ok(InboxMessageSchema, 'Queued'),
    ...writes,
    409: {
      description:
        'Window closed / customer blocked / number not ready (WHATSAPP_WINDOW_CLOSED, WHATSAPP_RECIPIENT_BLOCKED, WHATSAPP_CHANNEL_NOT_READY)',
    },
  },
});
for (const [path, summary, perm] of [
  [
    'read',
    'Mark read — unread 0, blue ticks when the account sends read receipts (impersonators: no change)',
    'inbox.read',
  ],
  ['unread', 'Mark as unread (team only, no Meta call)', 'inbox.read'],
] as const) {
  registry.registerPath({
    method: 'post',
    path: `${base}/conversations/{id}/${path}`,
    tags,
    summary: `${summary} (${perm})`,
    security: bearer,
    request: { params: ConversationParams },
    responses: { 204: noContentResponse, ...common },
  });
}
registry.registerPath({
  method: 'post',
  path: `${base}/conversations/{id}/typing`,
  tags,
  summary:
    'Typing ping: other agents see it; the customer sees "typing…" inside the window (inbox.reply, throttled)',
  security: bearer,
  request: { params: ConversationParams },
  responses: { 200: ok(z.object({ sent: z.boolean() })), ...writes },
});
registry.registerPath({
  method: 'patch',
  path: `${base}/conversations/{id}`,
  tags,
  summary:
    'Assign / unassign (inbox.assign; agents may take or drop it themselves with inbox.reply)',
  security: bearer,
  request: { params: ConversationParams, ...json(AssignBody) },
  responses: { 200: ok(InboxConversationDetailSchema), ...writes },
});
for (const [path, summary, perm] of [
  ['close', 'Close', 'inbox.reply'],
  ['reopen', 'Reopen', 'inbox.reply'],
  [
    'block',
    'Block the customer on WhatsApp (only after a message in the last 24 h)',
    'inbox.assign',
  ],
  ['unblock', 'Unblock the customer on WhatsApp', 'inbox.assign'],
] as const) {
  registry.registerPath({
    method: 'post',
    path: `${base}/conversations/{id}/${path}`,
    tags,
    summary: `${summary} (${perm})`,
    security: bearer,
    request: { params: ConversationParams },
    responses: {
      200: ok(InboxConversationDetailSchema),
      ...writes,
      502: { description: 'Meta returned an error (META_API_ERROR)' },
    },
  });
}
registry.registerPath({
  method: 'post',
  path: `${base}/media`,
  tags,
  summary: `Upload a file to send (inbox.reply; ${String(INBOX_LIMITS.uploadsPerMinutePerUser)} / min / user)`,
  description:
    'The bytes are checked against the kind (magic bytes) with WhatsApp size caps. `voice`: OGG / Opus as is, WebM / Opus (browser recordings) remuxed to OGG, M4A sent as an audio file.',
  security: bearer,
  request: multipart({ kind: z.enum(UPLOAD_KINDS), durationSec: z.number().optional() }),
  responses: {
    201: ok(UploadResultSchema, 'Stored'),
    ...writes,
    413: { description: 'Too large for WhatsApp (WHATSAPP_MEDIA_TOO_LARGE)' },
  },
});
registry.registerPath({
  method: 'get',
  path: `${base}/messages/{id}/media`,
  tags,
  summary: `Signed link to a message's file (${String(INBOX_LIMITS.mediaLinkTtlSec)} s; inbox.read)`,
  security: bearer,
  request: { params: MessageParams },
  responses: {
    200: ok(z.object({ url: z.string(), mimeType: s, fileName: s, expiresInSec: z.number() })),
    ...common,
  },
});
registry.registerPath({
  method: 'post',
  path: `${base}/messages/{id}/retry`,
  tags,
  summary: 'Send a failed message again as a new message (inbox.reply)',
  security: bearer,
  request: { params: MessageParams },
  responses: { 201: ok(InboxMessageSchema, 'Queued'), ...writes },
});
registry.registerPath({
  method: 'post',
  path: `${base}/messages/{id}/media/retry`,
  tags,
  summary: 'Download an inbound file again (inbox.assign; < 7 days)',
  security: bearer,
  request: { params: MessageParams },
  responses: {
    204: noContentResponse,
    ...writes,
    410: { description: 'Older than 7 days (INBOX_MEDIA_EXPIRED)' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/account/inbox-settings',
  tags,
  summary:
    'Inbox settings: read receipts, opt-out / opt-in keywords, confirmations, notifications (account.read)',
  security: bearer,
  responses: { 200: ok(InboxSettingsSchema), 401: errors[401], 403: errors[403] },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/account/inbox-settings',
  tags,
  summary: 'Change inbox settings (account.update)',
  security: bearer,
  request: json(InboxSettingsPatchBody),
  responses: { 200: ok(InboxSettingsSchema), 401: errors[401], 403: errors[403], 422: errors[422] },
});

const waTags = ['WhatsApp'];
registry.registerPath({
  method: 'get',
  path: '/api/v1/whatsapp/channels/{id}/profile',
  tags: waTags,
  summary: 'Business profile of a number (whatsapp.read)',
  security: bearer,
  request: { params: ChannelParams },
  responses: {
    200: ok(BusinessProfileSchema),
    ...common,
    409: errors[409],
    502: { description: 'META_API_ERROR' },
  },
});
registry.registerPath({
  method: 'patch',
  path: '/api/v1/whatsapp/channels/{id}/profile',
  tags: waTags,
  summary: 'Edit the business profile (whatsapp.manage)',
  security: bearer,
  request: { params: ChannelParams, ...json(BusinessProfilePatchBody) },
  responses: { 200: ok(BusinessProfileSchema), ...writes, 502: { description: 'META_API_ERROR' } },
});
registry.registerPath({
  method: 'post',
  path: '/api/v1/whatsapp/channels/{id}/profile/photo',
  tags: waTags,
  summary: 'New profile photo — JPEG / PNG, square 192–640 px, ≤ 5 MB (whatsapp.manage)',
  security: bearer,
  request: { params: ChannelParams, ...multipart({}) },
  responses: {
    200: ok(BusinessProfileSchema),
    ...writes,
    413: { description: 'WHATSAPP_MEDIA_TOO_LARGE' },
    502: { description: 'META_API_ERROR' },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/v1/dev/meta/media/{id}',
  tags: ['Dev'],
  summary: 'DEV ONLY — fake Meta media download (signed `exp` / `sig`, Bearer required like Meta)',
  request: {
    params: z.object({ id: z.string() }),
    query: z.object({ exp: z.string(), sig: z.string() }),
  },
  responses: {
    200: { description: 'The file bytes' },
    403: errors[403],
    404: errors[404],
  },
});
registry.registerPath({
  method: 'get',
  path: '/api/v1/dev/meta/sent',
  tags: ['Dev'],
  summary:
    'DEV ONLY — what the fake Meta received for a number: sends (no texts) and read receipts',
  security: bearer,
  request: { query: z.object({ channelId: z.string() }) },
  responses: {
    200: ok(
      z.object({
        sent: z.array(
          z.object({
            waMessageId: z.string(),
            phoneNumberId: z.string(),
            toLast4: z.string(),
            type: z.string(),
            interactiveType: s,
            mediaId: s,
            replyTo: z.boolean(),
            voiceValid: z.boolean().nullable(),
            at: z.string(),
          }),
        ),
        readReceipts: z.array(
          z.object({ waMessageId: z.string(), typing: z.boolean(), at: z.string() }),
        ),
      }),
    ),
    ...common,
  },
});
