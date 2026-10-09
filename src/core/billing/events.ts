import { EventEmitter } from 'node:events';

import { BILLING_LIMITS } from '../../config/limits';
import { notifyAccount } from '../realtime/notify';

/** The money numbers that alerts and events look at. */
export interface WalletSnapshot {
  balanceMicros: number;
  holdMicros: number;
  creditLimitMicros: number;
  lowBalanceThresholdMicros: number;
}

export type WalletStatus = 'ok' | 'low' | 'exhausted';

/** What the account can still spend (holds may use the credit limit). */
export const availableMicros = (w: WalletSnapshot): number =>
  w.balanceMicros + w.creditLimitMicros - w.holdMicros;

export const walletStatus = (w: WalletSnapshot): WalletStatus => {
  const available = availableMicros(w);
  if (available <= 0) return 'exhausted';
  if (w.lowBalanceThresholdMicros > 0 && available < w.lowBalanceThresholdMicros) return 'low';
  return 'ok';
};

export type WalletCrossing = 'low_balance' | 'exhausted' | 'replenished' | 'recovered';

/**
 * Threshold crossings between two snapshots: `low_balance` (fell below the
 * threshold), `exhausted` (reached ≤ 0), `replenished` (back above 0),
 * `recovered` (back at / above the threshold — re-arms the low alert).
 */
export const crossings = (before: WalletSnapshot, after: WalletSnapshot): WalletCrossing[] => {
  const was = availableMicros(before);
  const now = availableMicros(after);
  const threshold = after.lowBalanceThresholdMicros;
  const out: WalletCrossing[] = [];
  if (threshold > 0 && was >= threshold && now < threshold) out.push('low_balance');
  if (was > 0 && now <= 0) out.push('exhausted');
  if (was <= 0 && now > 0) out.push('replenished');
  if (threshold > 0 && was < threshold && now >= threshold) out.push('recovered');
  return out;
};

export interface WalletChange {
  accountId: string;
  before: WalletSnapshot;
  after: WalletSnapshot;
}

/** In-process wallet events (Phase 8 subscribes to `exhausted` / `replenished`). */
export interface WalletEventMap {
  updated: [WalletChange];
  low_balance: [WalletChange];
  exhausted: [WalletChange];
  replenished: [WalletChange];
  recovered: [WalletChange];
}

export const walletEvents = new EventEmitter<WalletEventMap>();
walletEvents.setMaxListeners(50);

const wsPayload = (after: WalletSnapshot) => ({
  balanceMicros: after.balanceMicros,
  holdMicros: after.holdMicros,
  availableMicros: availableMicros(after),
  currency: 'INR',
  status: walletStatus(after),
});

interface Throttle {
  lastSentAt: number;
  pending: WalletSnapshot | null;
  timer: NodeJS.Timeout | null;
}
const throttles = new Map<string, Throttle>();

/**
 * `wallet.updated` at most once per second per account; the last change in a
 * burst is always sent (trailing emit).
 */
export const emitWalletUpdated = (accountId: string, after: WalletSnapshot): void => {
  const now = Date.now();
  const t = throttles.get(accountId) ?? { lastSentAt: 0, pending: null, timer: null };
  throttles.set(accountId, t);
  const wait = BILLING_LIMITS.walletUpdateThrottleMs - (now - t.lastSentAt);
  if (wait <= 0 && !t.timer) {
    t.lastSentAt = now;
    notifyAccount(accountId, 'wallet.updated', wsPayload(after));
    return;
  }
  t.pending = after;
  if (t.timer) return;
  t.timer = setTimeout(
    () => {
      t.timer = null;
      t.lastSentAt = Date.now();
      if (t.pending) notifyAccount(accountId, 'wallet.updated', wsPayload(t.pending));
      t.pending = null;
    },
    Math.max(wait, 0),
  );
  t.timer.unref();
};

/** Tests only: forget throttle state and pending timers. */
export const resetWalletEventThrottle = (): void => {
  for (const t of throttles.values()) if (t.timer) clearTimeout(t.timer);
  throttles.clear();
};

/** Hook for alerts (T4.5); the engine calls it after every committed change. */
export type WalletChangeHook = (change: WalletChange) => Promise<void> | void;

let alertHook: WalletChangeHook = () => undefined;

export const setWalletChangeHook = (hook: WalletChangeHook): void => {
  alertHook = hook;
};

/** Runs after commit: WS update, internal events, alerts. Never throws. */
export const publishWalletChange = async (change: WalletChange): Promise<void> => {
  emitWalletUpdated(change.accountId, change.after);
  walletEvents.emit('updated', change);
  for (const c of crossings(change.before, change.after)) walletEvents.emit(c, change);
  if (availableMicros(change.after) <= 0 && availableMicros(change.before) > 0) {
    notifyAccount(change.accountId, 'wallet.exhausted', {
      availableMicros: availableMicros(change.after),
    });
  }
  try {
    await alertHook(change);
  } catch {
    // alerts must never break a money operation — the hook logs its own errors
  }
};
