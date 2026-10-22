import { WHATSAPP_LIMITS } from '../../config/limits';
import { META_EVENT_STATUSES } from '../../db/models/meta-webhook-event.model';
import { META_PAYERS, WA_CHANNEL_STATUSES, WA_MODES } from '../../db/models/whatsapp-channel.model';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';
import { INBOX_SIMULATOR_KINDS } from '../inbox/simulator-kinds';

import { SIMULATOR_KINDS } from './simulator';

/** Meta ids are digits; the fake provider's ids start with `fake_`. */
const MetaId = z
  .string()
  .max(64)
  .regex(/^(\d+|fake_[a-z]+_[0-9a-f]{12})$/, 'Must be a Meta id')
  .openapi({ example: '106540352242922' });

export const ChannelParams = z.strictObject({ id: ObjectIdSchema });

export const EmbeddedSignupBody = z
  .strictObject({
    code: z.string().min(1).max(2048).openapi({ description: 'Code from FB.login (single use)' }),
    sessionInfo: z
      .strictObject({ wabaId: MetaId.optional(), phoneNumberId: MetaId.optional() })
      .optional()
      .openapi({ description: 'WA_EMBEDDED_SIGNUP ids — hints, verified against debug_token' }),
    mode: z.enum(WA_MODES),
  })
  .openapi('WhatsAppEmbeddedSignupInput');
export type EmbeddedSignupInput = z.infer<typeof EmbeddedSignupBody>;

export const RenameChannelBody = z
  .strictObject({ label: z.string().trim().min(1).max(WHATSAPP_LIMITS.labelMax) })
  .openapi('WhatsAppRenameInput');

export const RegisterPinBody = z
  .strictObject({
    pin: z.string().regex(/^\d{6}$/, 'Must be the 6-digit two-step verification PIN'),
  })
  .openapi('WhatsAppRegisterPinInput');

export const ListChannelsQuery = z.strictObject({
  status: z.enum(WA_CHANNEL_STATUSES).optional(),
});
export type ListChannelsQueryInput = z.infer<typeof ListChannelsQuery>;

// ── superadmin ─────────────────────────────────────────────────────────────

export const AdminDisconnectBody = z
  .strictObject({ reason: z.string().trim().min(3).max(200) })
  .openapi('WhatsAppAdminDisconnectInput');

export const WhatsAppBillingBody = z
  .strictObject({ metaPayer: z.enum(META_PAYERS) })
  .openapi('WhatsAppBillingInput');

export const ManualConnectBody = z
  .strictObject({
    wabaId: MetaId,
    phoneNumberId: MetaId,
    accessToken: z
      .string()
      .min(20)
      .max(1000)
      .openapi({ description: 'System User token (never stored in plain text)' }),
  })
  .openapi('WhatsAppManualConnectInput');

export const EventParams = z.strictObject({ id: ObjectIdSchema });

export const ListEventsQuery = z.strictObject({
  status: z.enum(META_EVENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ── dev simulator ──────────────────────────────────────────────────────────

/** Phase 9 kinds + the Phase 10 inbox kinds (one endpoint). */
export const ALL_SIMULATOR_KINDS = [
  ...SIMULATOR_KINDS,
  ...INBOX_SIMULATOR_KINDS.filter((k) => !(SIMULATOR_KINDS as readonly string[]).includes(k)),
] as const;

export const SimulatorBody = z
  .strictObject({
    channelId: ObjectIdSchema,
    kind: z.enum(ALL_SIMULATOR_KINDS),
    /** Inbox kinds: the customer (default a test number), text, conversation, days. */
    from: z
      .string()
      .trim()
      .regex(/^\+?\d[\d\s-]{5,19}$/)
      .optional(),
    text: z.string().trim().min(1).max(1000).optional(),
    conversationId: ObjectIdSchema.optional(),
    days: z.number().int().min(1).max(3650).optional(),
  })
  .openapi('WhatsAppSimulatorInput');
