/**
 * `analytics-reconcile` (nightly): recounts the last `reconcileDays` days of every
 * account from raw rows, fixes any difference (the sweep missed a late commit, a bug)
 * and tells the superadmins; drops rollups past `rollupRetentionMonths`.
 */
import type { Types } from 'mongoose';

import { REPORT_LIMITS } from '../../config/limits';
import { AccountModel } from '../../db/models/account.model';
import { StatsDailyModel } from '../../db/models/stats-daily.model';
import type { Logger } from '../../shared/logger';
import { addDays, ymdInZone } from '../../shared/time';
import { notifyPlatform } from '../notifications/notifications.service';

import { rawFloor, rebuildAccount } from './rebuild';
import { withAnalyticsLock, type AnalyticsDeps } from './sweep';

export interface ReconcileDeps extends AnalyticsDeps {
  logger: Logger;
  /** Platform raw-data retention (env): rebuilds never reach past it. */
  retention: { callsDays: number; inboxDays: number };
}

/** First day kept (UTC calendar): `rollupRetentionMonths` before today. */
export const rollupCutoff = (now: Date): string => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() - REPORT_LIMITS.rollupRetentionMonths);
  return d.toISOString().slice(0, 10);
};

export const reconcileAnalytics = async (deps: ReconcileDeps): Promise<Record<string, number>> => {
  const now = deps.now?.() ?? new Date();
  const result = await withAnalyticsLock(deps, async () => {
    const accounts = await AccountModel.find({})
      .select({ timezone: 1 })
      .lean<{ _id: Types.ObjectId; timezone?: string }[]>();
    let fixedAccounts = 0;
    let fixedRows = 0;
    for (const a of accounts) {
      const tz = a.timezone ?? 'Asia/Kolkata';
      const to = ymdInZone(now, tz);
      const r = await rebuildAccount({
        accountId: a._id,
        from: addDays(to, -(REPORT_LIMITS.reconcileDays - 1)),
        to,
        floor: rawFloor(now, tz, deps.retention),
      });
      if (r.differences > 0) {
        fixedAccounts += 1;
        fixedRows += r.differences;
      }
    }
    const expired = await StatsDailyModel.deleteMany({ day: { $lt: rollupCutoff(now) } });
    if (fixedRows > 0) {
      deps.logger.warn(
        { accounts: fixedAccounts, rows: fixedRows },
        'analytics: recount fixed rollups',
      );
      await notifyPlatform({
        type: 'analytics.reconcile_mismatch',
        title: 'Report numbers corrected',
        body: `The nightly recount corrected ${String(fixedRows)} daily report rows in ${String(fixedAccounts)} account(s). Check the server logs if this repeats.`,
        link: '/admin',
      });
    }
    return {
      accounts: accounts.length,
      fixedAccounts,
      fixedRows,
      expiredRows: expired.deletedCount,
    };
  });
  return result ?? { skipped: 1 };
};
