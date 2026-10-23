import { z } from '../../shared/openapi/zod';
import { ObjectIdSchema } from '../../shared/validation/schemas';

import { PRICE_NOTES } from './price-preview.service';

export const PricePreviewBody = z
  .object({
    channelId: ObjectIdSchema,
    contactId: ObjectIdSchema.optional(),
    phone: z.string().trim().min(6).max(30).optional(),
    templateId: ObjectIdSchema.optional(),
    category: z.enum(['marketing', 'utility', 'authentication', 'service']).optional(),
  })
  .refine((b) => Boolean(b.contactId) !== Boolean(b.phone), {
    message: 'Give a contact or a phone (one of them)',
    path: ['contactId'],
  })
  .refine((b) => !(b.templateId && b.category), {
    message: 'Give a template or a category',
    path: ['category'],
  })
  .openapi('WhatsAppPricePreviewBody');

export const PricePreviewSchema = z
  .object({
    payer: z.enum(['platform', 'customer']),
    market: z.string(),
    marketLabel: z.string(),
    category: z.enum([
      'marketing',
      'utility',
      'authentication',
      'authentication_international',
      'service',
    ]),
    priceMicros: z.number().int(),
    currency: z.literal('INR'),
    note: z.enum(PRICE_NOTES),
  })
  .openapi('WhatsAppPricePreview');
