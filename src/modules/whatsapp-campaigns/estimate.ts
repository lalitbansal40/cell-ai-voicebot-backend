import { parsePhoneNumberFromString } from 'libphonenumber-js';

import type { PriceCategory } from '../../core/billing/whatsapp';
import { WalletModel, type WalletDoc } from '../../db/models/wallet.model';
import type { WhatsAppCampaignDoc } from '../../db/models/whatsapp-campaign.model';
import { WhatsAppCampaignModel } from '../../db/models/whatsapp-campaign.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { ValidationError } from '../../shared/errors/app-error';
import { priceMessage } from '../whatsapp-billing/pricing.service';

import { resolveAudienceBatches } from './audience';
import { loadVariants } from './variants';

export const estimateCampaignDoc = async (c: WhatsAppCampaignDoc) => {
  const channel = await WhatsAppChannelModel.findOne({
    _id: c.channelId,
    accountId: c.accountId,
  }).lean<WhatsAppChannelDoc>();
  if (!channel)
    throw new ValidationError([{ path: 'channelId', message: 'Unknown WhatsApp number' }]);
  const variants = await loadVariants(c, channel.wabaId);
  const priceCache = new Map<string, { market: string; priceMicros: number }>();
  const byMarket = new Map<
    string,
    { market: string; category: string; count: number; priceMicros: number }
  >();
  const skipped: Record<string, number> = {};
  let totalMicros = 0;
  let recipients = 0;
  for await (const batch of resolveAudienceBatches(c, variants)) {
    for (const { contact, variant, skipReason } of batch) {
      if (skipReason) {
        skipped[skipReason] = (skipped[skipReason] ?? 0) + 1;
        continue;
      }
      const category = variant.category.toLowerCase() as PriceCategory;
      const country = parsePhoneNumberFromString(contact.phoneE164)?.country ?? contact.phoneE164;
      const key = `${country}:${category}`;
      let quote = priceCache.get(key);
      if (!quote) {
        quote = await priceMessage({
          accountId: c.accountId,
          payer: channel.metaPayer,
          phoneE164: contact.phoneE164,
          category,
        });
        priceCache.set(key, quote);
      }
      const group = `${quote.market}:${category}:${String(quote.priceMicros)}`;
      const market = byMarket.get(group) ?? {
        market: quote.market,
        category,
        count: 0,
        priceMicros: quote.priceMicros,
      };
      market.count += 1;
      byMarket.set(group, market);
      totalMicros += quote.priceMicros;
      recipients += 1;
    }
  }
  const wallet = await WalletModel.findOne({ accountId: c.accountId }).lean<WalletDoc>();
  const available = wallet
    ? wallet.balanceMicros - wallet.holdMicros + wallet.creditLimitMicros
    : 0;
  await WhatsAppCampaignModel.updateOne(
    { _id: c._id },
    { $set: { 'cost.estimateMicros': totalMicros } },
  );
  return {
    recipients,
    skipped,
    byMarket: [...byMarket.values()],
    shortfallMicros: Math.max(0, totalMicros - available),
    totalMicros,
    walletAvailableMicros: Math.max(0, available),
    enough: available >= totalMicros,
    note: 'Eligible contacts priced by assigned template category and market. Eligibility and wallet are checked again at start.',
  };
};
