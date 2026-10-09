import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as notify from '../realtime/notify';

import {
  availableMicros,
  crossings,
  emitWalletUpdated,
  publishWalletChange,
  resetWalletEventThrottle,
  setWalletChangeHook,
  walletEvents,
  walletStatus,
  type WalletSnapshot,
} from './events';

const w = (balance: number, extra: Partial<WalletSnapshot> = {}): WalletSnapshot => ({
  balanceMicros: balance,
  holdMicros: 0,
  creditLimitMicros: 0,
  lowBalanceThresholdMicros: 500,
  ...extra,
});

let sent: { type: string; data: unknown }[] = [];
beforeEach(() => {
  sent = [];
  vi.spyOn(notify, 'notifyAccount').mockImplementation((_id, type, data) => {
    sent.push({ type, data });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetWalletEventThrottle();
  walletEvents.removeAllListeners();
  setWalletChangeHook(() => undefined);
});

describe('status and crossings', () => {
  it('derives available and status', () => {
    expect(availableMicros(w(100, { holdMicros: 30, creditLimitMicros: 10 }))).toBe(80);
    expect(walletStatus(w(1000))).toBe('ok');
    expect(walletStatus(w(499))).toBe('low');
    expect(walletStatus(w(0))).toBe('exhausted');
    expect(walletStatus(w(10, { lowBalanceThresholdMicros: 0 }))).toBe('ok');
  });

  it('detects each crossing once', () => {
    expect(crossings(w(600), w(400))).toEqual(['low_balance']);
    expect(crossings(w(600), w(0))).toEqual(['low_balance', 'exhausted']);
    expect(crossings(w(400), w(300))).toEqual([]);
    expect(crossings(w(0), w(100))).toEqual(['replenished']);
    expect(crossings(w(-5), w(900))).toEqual(['replenished', 'recovered']);
    expect(crossings(w(400), w(500))).toEqual(['recovered']);
    expect(
      crossings(w(600, { lowBalanceThresholdMicros: 0 }), w(1, { lowBalanceThresholdMicros: 0 })),
    ).toEqual([]);
  });
});

describe('wallet.updated throttle', () => {
  it('sends at most one per second with a trailing update', () => {
    vi.useFakeTimers();
    emitWalletUpdated('a1', w(100));
    emitWalletUpdated('a1', w(90));
    emitWalletUpdated('a1', w(80));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'wallet.updated',
      data: {
        balanceMicros: 100,
        holdMicros: 0,
        availableMicros: 100,
        currency: 'INR',
        status: 'low',
      },
    });
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(2);
    expect((sent[1]?.data as { balanceMicros: number }).balanceMicros).toBe(80);
    vi.advanceTimersByTime(1500);
    emitWalletUpdated('a1', w(70));
    expect(sent).toHaveLength(3);
    emitWalletUpdated('a2', w(1)); // other accounts aren't throttled by a1
    expect(sent).toHaveLength(4);
  });
});

describe('publishWalletChange', () => {
  it('emits events, the WS exhausted event and calls the alert hook', async () => {
    const hook = vi.fn();
    setWalletChangeHook(hook);
    const seen: string[] = [];
    for (const e of ['updated', 'low_balance', 'exhausted', 'replenished', 'recovered'] as const) {
      walletEvents.on(e, () => seen.push(e));
    }
    const change = { accountId: 'a3', before: w(600), after: w(0) };
    await publishWalletChange(change);
    expect(seen).toEqual(['updated', 'low_balance', 'exhausted']);
    expect(sent.map((s) => s.type)).toEqual([
      'wallet.updated',
      'wallet.low_balance',
      'wallet.exhausted',
    ]);
    expect(sent[1]?.data).toEqual({ availableMicros: 0, thresholdMicros: 500 });
    expect(sent[2]?.data).toEqual({ availableMicros: 0 });
    expect(hook).toHaveBeenCalledWith(change);
  });

  it('never throws when the alert hook fails', async () => {
    setWalletChangeHook(() => Promise.reject(new Error('smtp down')));
    await expect(
      publishWalletChange({ accountId: 'a4', before: w(10), after: w(20) }),
    ).resolves.toBeUndefined();
  });
});
