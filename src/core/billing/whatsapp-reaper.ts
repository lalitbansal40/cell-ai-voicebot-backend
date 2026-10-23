import type { Types } from 'mongoose';

import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import { LedgerEntryModel } from '../../db/models/ledger-entry.model';
import { MessageModel } from '../../db/models/message.model';
import {
  DEFAULT_WHATSAPP_BILLING_SETTINGS,
  PlatformSettingsModel,
} from '../../db/models/platform-settings.model';
import { getLogger } from '../../shared/logger';

import { releaseWhatsAppMany } from './engine';

/**
 * `billing.whatsapp_reap_holds` (every 30 min): WhatsApp holds older than
 * `holdMaxAgeHours` (72 h) without a decisive status are released (`no_delivery`) and
 * their message marked `released`. A billable status that still arrives charges late.
 */
export const reapWhatsAppHolds = async (
  now = new Date(),
  /** Dev simulator: only this account's holds. */
  scope: { accountId?: Types.ObjectId } = {},
): Promise<{ released: number }> => {
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
    ...(scope.accountId ? { accountId: scope.accountId } : {}),
  })
    .select({ accountId: 1 })
    .limit(WHATSAPP_BILLING_LIMITS.reapBatch)
    .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId }[]>();
  // one transaction per account (5,000 stale holds of a busy day → a few transactions)
  const byAccount = new Map<string, { accountId: Types.ObjectId; ids: Types.ObjectId[] }>();
  for (const r of rows) {
    const k = r.accountId.toString();
    const entry = byAccount.get(k) ?? { accountId: r.accountId, ids: [] };
    entry.ids.push(r._id);
    byAccount.set(k, entry);
  }
  let released = 0;
  for (const { accountId, ids } of byAccount.values()) {
    try {
      const res = await releaseWhatsAppMany({ accountId, holdIds: ids, reason: 'no_delivery' });
      if (res.released.length) {
        await MessageModel.updateMany(
          { accountId, 'billing.holdId': { $in: res.released }, 'billing.status': 'held' },
          { $set: { 'billing.status': 'released', 'billing.at': now } },
        );
      }
      released += res.released.length;
    } catch (err) {
      getLogger().error(
        { errName: (err as Error).name, accountId: accountId.toString(), holds: ids.length },
        'billing: whatsapp hold release failed',
      );
    }
  }
  return { released };
};
