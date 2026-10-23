import type { Types } from 'mongoose';

import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { MessageModel } from '../../db/models/message.model';
import {
  DEFAULT_WHATSAPP_BILLING_SETTINGS,
  PlatformSettingsModel,
} from '../../db/models/platform-settings.model';
import { getLogger } from '../../shared/logger';

import { releaseWhatsApp } from './engine';

/**
 * `billing.whatsapp_reap_holds` (every 30 min): WhatsApp holds older than
 * `holdMaxAgeHours` (72 h) without a decisive status are released (`no_delivery`) and
 * their message marked `released`. A billable status that still arrives charges late.
 */
export const reapWhatsAppHolds = async (now = new Date()): Promise<{ released: number }> => {
  const settings = await PlatformSettingsModel.findOne({ key: 'whatsappBilling' }).lean<{
    value?: { holdMaxAgeHours?: number };
  }>();
  const hours =
    settings?.value?.holdMaxAgeHours ?? DEFAULT_WHATSAPP_BILLING_SETTINGS.holdMaxAgeHours;
  const cutoff = new Date(now.getTime() - hours * 3_600_000);
  const rows = await LedgerEntryModel.find({
    type: 'whatsapp_charge',
    status: 'held',
    createdAt: { $lt: cutoff },
  })
    .select({ accountId: 1 })
    .limit(WHATSAPP_BILLING_LIMITS.reapBatch)
    .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId }[]>();
  let released = 0;
  for (const r of rows) {
    try {
      const res = await releaseWhatsApp({
        accountId: r.accountId,
        holdId: r._id,
        reason: 'no_delivery',
      });
      await MessageModel.updateOne(
        { accountId: r.accountId, 'billing.holdId': r._id, 'billing.status': 'held' },
        { $set: { 'billing.status': 'released', 'billing.at': now } },
      );
      if (!res.replay) released += 1;
    } catch (err) {
      getLogger().error(
        { errName: (err as Error).name, holdId: r._id.toString() },
        'billing: whatsapp hold release failed',
      );
    }
  }
  return { released };
};
