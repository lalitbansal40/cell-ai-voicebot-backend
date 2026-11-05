import type { Types } from 'mongoose';

import { WHATSAPP_CALL_LIMITS } from '../../config/limits';
import { effectiveRateCard } from '../../core/billing/rates';
import { callPrice } from '../../core/billing/whatsapp-calls';
import { ContactModel } from '../../db/models/contact.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { NotFoundError } from '../../shared/errors/app-error';

import { quoteCall } from './billing';

/** Selling prices for the exact sender/contact; never exposes Meta cost or markup. */
export const callPricePreview = async (
  accountId: Types.ObjectId,
  channelId: string,
  contactId: string,
) => {
  const [channel, contact] = await Promise.all([
    WhatsAppChannelModel.findOne({ _id: channelId, accountId, status: { $ne: 'disconnected' } })
      .select({ metaPayer: 1, label: 1, displayPhoneNumber: 1, phoneE164: 1 })
      .lean<{
        metaPayer: 'platform' | 'customer';
        label: string;
        displayPhoneNumber?: string | null;
        phoneE164?: string | null;
      }>(),
    ContactModel.findOne({ _id: contactId, accountId })
      .select({ phoneE164: 1 })
      .lean<{ phoneE164: string }>(),
  ]);
  if (!channel) throw new NotFoundError('WhatsApp number not found');
  if (!contact) throw new NotFoundError('Contact not found');
  const [quote, rates] = await Promise.all([
    quoteCall({ accountId, phoneE164: contact.phoneE164, payer: channel.metaPayer }),
    effectiveRateCard(accountId),
  ]);
  return {
    channelId,
    contactId,
    senderLabel: channel.label,
    senderPhone: channel.displayPhoneNumber ?? channel.phoneE164 ?? null,
    market: quote.market,
    callPerMinuteMicros: callPrice(quote, 60).totalMicros,
    aiPerMinuteMicros: rates.aiPerMinuteMicros,
    pulseSec: WHATSAPP_CALL_LIMITS.pulseSec,
  };
};
