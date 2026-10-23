import type { Types } from 'mongoose';

import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import { rateToMicros } from '../../core/billing/whatsapp';
import { isMetaApiError } from '../../core/meta';
import { MessageModel } from '../../db/models/message.model';
import {
  BILLING_DAILY_CATEGORIES,
  WhatsAppBillingDailyModel,
  type BillingDailyCategory,
} from '../../db/models/whatsapp-billing-daily.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { getLogger } from '../../shared/logger';
import { openSecret, type WhatsAppContext } from '../whatsapp/context';

const DAY = 86_400_000;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const asCategory = (c: string | null | undefined): BillingDailyCategory | null =>
  c && (BILLING_DAILY_CATEGORIES as readonly string[]).includes(c.toLowerCase())
    ? (c.toLowerCase() as BillingDailyCategory)
    : null;

interface Totals {
  volume: number;
  micros: number;
}

/**
 * `billing.whatsapp_reconcile` (03:00 IST): for every WABA we pay Meta for, the last
 * `reconcileDays` full UTC days of Meta's `pricing_analytics` against our captured
 * message charges, per day × category → `whatsappBillingDaily` (superadmin report).
 */
export const runWhatsAppReconcile = async (
  wa: WhatsAppContext,
  now = new Date(),
): Promise<{ wabas: number; rows: number; failed: number }> => {
  const end = new Date(Math.floor(now.getTime() / DAY) * DAY);
  const start = new Date(end.getTime() - WHATSAPP_BILLING_LIMITS.reconcileDays * DAY);
  const channels = await WhatsAppChannelModel.find({
    metaPayer: 'platform',
    status: { $in: ['connected', 'restricted'] },
  })
    .select('+tokenSealed')
    .sort({ createdAt: 1 })
    .lean<WhatsAppChannelDoc[]>();
  const wabas = new Map<string, { channel: WhatsAppChannelDoc; channelIds: Types.ObjectId[] }>();
  for (const c of channels) {
    const k = `${c.accountId.toString()}|${c.wabaId}`;
    const entry = wabas.get(k) ?? { channel: c, channelIds: [] };
    entry.channelIds.push(c._id);
    wabas.set(k, entry);
  }
  let rows = 0;
  let failed = 0;
  for (const { channel, channelIds } of wabas.values()) {
    try {
      if (!channel.tokenSealed) throw new Error('no token');
      const points = await wa.meta.getPricingAnalytics(
        openSecret(wa, channel.tokenSealed),
        channel.wabaId,
        { start, end },
      );
      const meta = new Map<string, Totals>();
      for (const p of points) {
        const category = asCategory(p.category);
        if (!category) continue;
        const k = `${dayOf(p.start)}|${category}`;
        const t = meta.get(k) ?? { volume: 0, micros: 0 };
        t.volume += p.volume;
        t.micros += rateToMicros(String(p.cost)) ?? 0;
        meta.set(k, t);
      }
      const ours = await MessageModel.aggregate<{
        _id: { day: string; category: string };
        volume: number;
        micros: number;
      }>([
        {
          $match: {
            accountId: channel.accountId,
            channelId: { $in: channelIds },
            'billing.status': { $in: ['captured', 'late_charged'] },
            'billing.at': { $gte: start, $lt: end },
          },
        },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$billing.at' } },
              category: { $ifNull: ['$billing.metaCategory', '$billing.category'] },
            },
            volume: { $sum: 1 },
            micros: { $sum: '$billing.priceMicros' },
          },
        },
      ]);
      const our = new Map<string, Totals>();
      for (const o of ours) {
        const category = asCategory(o._id.category);
        if (!category) continue;
        const k = `${o._id.day}|${category}`;
        const t = our.get(k) ?? { volume: 0, micros: 0 };
        t.volume += o.volume;
        t.micros += o.micros;
        our.set(k, t);
      }
      for (const k of new Set([...meta.keys(), ...our.keys()])) {
        const [day = '', raw = 'service'] = k.split('|');
        const category = raw as BillingDailyCategory;
        const m = meta.get(k) ?? { volume: 0, micros: 0 };
        const o = our.get(k) ?? { volume: 0, micros: 0 };
        await WhatsAppBillingDailyModel.updateOne(
          { wabaId: channel.wabaId, day, category },
          {
            $set: {
              accountId: channel.accountId,
              metaVolume: m.volume,
              metaCostMicros: m.micros,
              ourCaptured: o.volume,
              ourBilledMicros: o.micros,
              diffVolume: o.volume - m.volume,
              diffMicros: o.micros - m.micros,
              fetchedAt: now,
            },
          },
          { upsert: true },
        );
        rows += 1;
      }
    } catch (err) {
      failed += 1;
      getLogger().warn(
        {
          channelId: channel._id.toString(),
          code: isMetaApiError(err) ? err.code : null,
          errName: (err as Error).name,
        },
        'whatsapp billing: reconcile failed for a WABA',
      );
    }
  }
  return { wabas: wabas.size, rows, failed };
};
