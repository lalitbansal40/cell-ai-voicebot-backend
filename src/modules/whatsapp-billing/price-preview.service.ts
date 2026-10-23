import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { Types } from 'mongoose';

import type { PriceCategory } from '../../core/billing/whatsapp';
import { ContactModel } from '../../db/models/contact.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';
import { AppError, NotFoundError, ValidationError } from '../../shared/errors/app-error';

import { priceMessage } from './pricing.service';

export const PRICE_NOTES = [
  'billed_when_delivered',
  'free_tier_may_apply',
  'customer_pays_meta',
] as const;
export type PriceNote = (typeof PRICE_NOTES)[number];

export interface PricePreviewInput {
  channelId: string;
  contactId?: string;
  phone?: string;
  templateId?: string;
  category?: 'marketing' | 'utility' | 'authentication' | 'service';
}

/**
 * What one message would cost (send dialog, inbox cost hint): the number's payer, the
 * recipient's market, the template's category (or the given one / `service`).
 */
export const pricePreview = async (accountId: Types.ObjectId, input: PricePreviewInput) => {
  if (!Types.ObjectId.isValid(input.channelId))
    throw new NotFoundError('WhatsApp number not found');
  const channel = await WhatsAppChannelModel.findOne({
    _id: input.channelId,
    accountId,
    status: { $ne: 'disconnected' },
  }).lean<WhatsAppChannelDoc>();
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  let phoneE164: string | null = null;
  if (input.contactId) {
    if (!Types.ObjectId.isValid(input.contactId)) throw new NotFoundError('Contact not found');
    const contact = await ContactModel.findOne({ _id: input.contactId, accountId, deletedAt: null })
      .select({ phoneE164: 1 })
      .lean<{ phoneE164: string }>();
    if (!contact) throw new NotFoundError('Contact not found');
    phoneE164 = contact.phoneE164;
  } else if (input.phone) {
    const parsed = parsePhoneNumberFromString(input.phone, 'IN');
    if (!parsed?.isValid())
      throw new ValidationError([{ path: 'phone', message: 'Not a phone number' }]);
    phoneE164 = parsed.number;
  }
  if (!phoneE164)
    throw new ValidationError([{ path: 'contactId', message: 'Give a contact or a phone' }]);
  let category: PriceCategory = input.category ?? 'service';
  if (input.templateId) {
    if (!Types.ObjectId.isValid(input.templateId)) throw new AppError('TEMPLATE_NOT_FOUND');
    const t = await WhatsAppTemplateModel.findOne({ _id: input.templateId, accountId })
      .select({ category: 1 })
      .lean<{ category: string }>();
    if (!t) throw new AppError('TEMPLATE_NOT_FOUND');
    category = t.category.toLowerCase() as PriceCategory;
  }
  const quote = await priceMessage({ accountId, payer: channel.metaPayer, phoneE164, category });
  const note: PriceNote =
    channel.metaPayer === 'customer'
      ? 'customer_pays_meta'
      : category === 'service'
        ? 'free_tier_may_apply'
        : 'billed_when_delivered';
  return {
    payer: quote.payer,
    market: quote.market,
    marketLabel: quote.marketLabel,
    category: quote.category,
    priceMicros: quote.priceMicros,
    currency: 'INR' as const,
    note,
  };
};
