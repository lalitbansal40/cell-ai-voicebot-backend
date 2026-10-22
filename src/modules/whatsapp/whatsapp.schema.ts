import { WHATSAPP_LIMITS } from '../../config/limits';
import { WA_CHANNEL_STATUSES, WA_MODES } from '../../db/models/whatsapp-channel.model';
import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

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
