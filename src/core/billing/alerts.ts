import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { BILLING_LIMITS } from '../../config/limits';
import { AccountModel } from '../../db/models/account.model';
import { WalletModel } from '../../db/models/wallet.model';
import { notify, usersWithPermission } from '../../modules/notifications/notifications.service';
import { getLogger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import { ymdInZone } from '../../shared/time';
import { getEmail } from '../email';

import { availableMicros, crossings, setWalletChangeHook, type WalletChange } from './events';

type AlertField = 'alerts.lowBalanceNotifiedAt' | 'alerts.exhaustedNotifiedAt';

/** Atomic "send at most once per 24 h": only one of many parallel debits wins. */
const claim = async (accountId: Types.ObjectId, field: AlertField, now: Date): Promise<boolean> => {
  const claimed = await WalletModel.findOneAndUpdate(
    {
      accountId,
      $or: [
        { [field]: null },
        { [field]: { $lt: new Date(now.getTime() - BILLING_LIMITS.alertCooldownMs) } },
      ],
    },
    { $set: { [field]: now } },
    { projection: { _id: 1 } },
  ).lean();
  return claimed !== null;
};

const rearm = (accountId: Types.ObjectId, field: AlertField) =>
  WalletModel.updateOne({ accountId }, { $set: { [field]: null } });

const sendAlert = async (accountId: Types.ObjectId, change: WalletChange, exhausted: boolean) => {
  const account = await AccountModel.findById(accountId)
    .select({ name: 1, timezone: 1 })
    .lean<{ name: string; timezone?: string }>();
  const accountName = account?.name ?? 'Your account';
  const available = formatInr(Math.max(availableMicros(change.after), 0));
  const threshold = formatInr(change.after.lowBalanceThresholdMicros);
  await notify({
    accountId,
    permission: 'wallet.read',
    type: exhausted ? 'wallet.exhausted' : 'wallet.low_balance',
    title: exhausted ? 'Wallet balance used up' : 'Wallet balance is low',
    body: exhausted
      ? `No balance left (${available}). New calls are refused until you add money.`
      : `${available} available — below your alert level of ${threshold}.`,
    link: '/wallet',
  });
  const recipients = await usersWithPermission(accountId, 'wallet.topup');
  const day = ymdInZone(new Date(), account?.timezone ?? 'Asia/Kolkata');
  const walletUrl = `${getEnv().FRONTEND_URL.replace(/\/+$/, '')}/wallet`;
  for (const r of recipients) {
    await getEmail().enqueue(
      'wallet.low_balance',
      r.email,
      { accountName, available, threshold, exhausted, walletUrl },
      {
        dedupeKey: `wallet-${exhausted ? 'exhausted' : 'low'}:${accountId.toString()}:${r.userId.toString()}:${day}`,
      },
    );
  }
};

/**
 * Low-balance / exhausted alerts (PHASE_4_PLAN §1f): in-app notification
 * for `wallet.read` users, email for `wallet.topup` users, at most once per
 * 24 h each; re-armed when the balance recovers.
 */
export const handleWalletChange = async (change: WalletChange): Promise<void> => {
  try {
    const found = crossings(change.before, change.after);
    if (!found.length) return;
    const accountId = new Types.ObjectId(change.accountId);
    const now = new Date();
    if (found.includes('recovered')) await rearm(accountId, 'alerts.lowBalanceNotifiedAt');
    if (found.includes('replenished')) await rearm(accountId, 'alerts.exhaustedNotifiedAt');
    if (found.includes('exhausted')) {
      // one email for the bigger event; also claim "low" so it doesn't follow later
      if (found.includes('low_balance')) await claim(accountId, 'alerts.lowBalanceNotifiedAt', now);
      if (await claim(accountId, 'alerts.exhaustedNotifiedAt', now)) {
        await sendAlert(accountId, change, true);
      }
    } else if (found.includes('low_balance')) {
      if (await claim(accountId, 'alerts.lowBalanceNotifiedAt', now)) {
        await sendAlert(accountId, change, false);
      }
    }
  } catch (err) {
    getLogger().error({ err, accountId: change.accountId }, 'billing: wallet alert failed');
  }
};

/** Installs the alert hook on the engine (once per process). */
export const registerWalletAlerts = (): void => {
  setWalletChangeHook(handleWalletChange);
};
