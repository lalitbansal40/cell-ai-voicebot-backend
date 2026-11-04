import type { Types } from 'mongoose';

import type { WhatsAppCampaignDoc } from '../../db/models/whatsapp-campaign.model';
import { WhatsAppTemplateModel } from '../../db/models/whatsapp-template.model';

import type { VariantInfo } from './audience';

/** Variant templates of a campaign (approved, on the campaign's WABA). */
export const loadVariants = async (
  campaign: Pick<WhatsAppCampaignDoc, 'accountId' | 'variants'>,
  wabaId: string,
): Promise<VariantInfo[]> => {
  const templates = await WhatsAppTemplateModel.find({
    _id: { $in: campaign.variants.map((v) => v.templateId) },
    accountId: campaign.accountId,
    wabaId,
  })
    .select({ category: 1, purpose: 1, variables: 1, status: 1 })
    .lean<
      {
        _id: Types.ObjectId;
        category: string;
        purpose?: string;
        status: string;
        variables: { key: string }[];
      }[]
    >();
  const byId = new Map(templates.map((t) => [t._id.toString(), t]));
  return campaign.variants.flatMap((v) => {
    const t = byId.get(v.templateId.toString());
    return t
      ? [
          {
            key: v.key,
            templateId: t._id,
            category: t.category,
            purpose: t.purpose ?? 'general',
            keys: [...new Set(t.variables.map((x) => x.key))],
            status: t.status,
          },
        ]
      : [];
  });
};
