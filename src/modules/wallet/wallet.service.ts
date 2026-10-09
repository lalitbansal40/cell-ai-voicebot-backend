import type { Request } from 'express';
import type { z } from 'zod';

import { monthKey } from '../../core/billing/engine';
import { availableMicros, walletStatus, type WalletSnapshot } from '../../core/billing/events';
import { estimateCampaign, holdEstimate } from '../../core/billing/pricing';
import { effectiveRateCard } from '../../core/billing/rates';
import { getOrCreateWallet, updateWalletSettings } from '../../core/billing/wallets';
import { AccountModel } from '../../db/models/account.model';
import type { WalletDoc } from '../../db/models/wallet.model';
import { tenantFilter } from '../../shared/auth/tenant';
import { auditRequest } from '../audit/audit.service';

import type { EstimateBody, WalletSettingsBody } from './wallet.schema';

export const accountTimezone = async (accountId: unknown): Promise<string> =>
  (await AccountModel.findById(accountId).select({ timezone: 1 }).lean<{ timezone?: string }>())
    ?.timezone ?? 'Asia/Kolkata';

const snap = (w: WalletDoc): WalletSnapshot => ({
  balanceMicros: w.balanceMicros,
  holdMicros: w.holdMicros,
  creditLimitMicros: w.creditLimitMicros,
  lowBalanceThresholdMicros: w.lowBalanceThresholdMicros,
});

/** Public wallet JSON (WalletSchema). Spend of an older month shows as 0. */
export const toWalletView = (w: WalletDoc, month: string) => {
  const current = w.spend.month === month;
  const call = current ? w.spend.callMicros : 0;
  const ai = current ? w.spend.aiMicros : 0;
  const tts = current ? w.spend.ttsMicros : 0;
  return {
    currency: 'INR' as const,
    balanceMicros: w.balanceMicros,
    holdMicros: w.holdMicros,
    availableMicros: availableMicros(snap(w)),
    creditLimitMicros: w.creditLimitMicros,
    status: walletStatus(snap(w)),
    lowBalanceThresholdMicros: w.lowBalanceThresholdMicros,
    budgets: {
      monthlyCallMicros: w.budgets.monthlyCallMicros,
      monthlyAiMicros: w.budgets.monthlyAiMicros,
    },
    monthSpend: {
      month,
      callMicros: call,
      aiMicros: ai,
      ttsMicros: tts,
      totalMicros: call + ai + tts,
    },
    updatedAt: w.updatedAt.toISOString(),
  };
};

export const getWallet = async (req: Request) => {
  const { accountId } = tenantFilter(req);
  const [wallet, tz] = await Promise.all([
    getOrCreateWallet(accountId),
    accountTimezone(accountId),
  ]);
  return toWalletView(wallet, monthKey(new Date(), tz));
};

export const updateSettings = async (req: Request, body: z.infer<typeof WalletSettingsBody>) => {
  const { accountId } = tenantFilter(req);
  const { before, after } = await updateWalletSettings(accountId, body);
  const fields: string[] = [];
  const from: Record<string, number> = {};
  const to: Record<string, number> = {};
  const track = (name: string, a: number, b: number) => {
    if (a === b) return;
    fields.push(name);
    from[name] = a;
    to[name] = b;
  };
  track(
    'lowBalanceThresholdMicros',
    before.lowBalanceThresholdMicros,
    after.lowBalanceThresholdMicros,
  );
  track('monthlyCallMicros', before.budgets.monthlyCallMicros, after.budgets.monthlyCallMicros);
  track('monthlyAiMicros', before.budgets.monthlyAiMicros, after.budgets.monthlyAiMicros);
  if (fields.length) {
    await auditRequest(req, 'wallet.settings_updated', {
      target: { type: 'wallet', id: after._id.toString() },
      meta: { fields, from, to },
    });
  }
  return toWalletView(after, monthKey(new Date(), await accountTimezone(accountId)));
};

export const getRates = async (req: Request) => {
  const card = await effectiveRateCard(tenantFilter(req).accountId);
  return {
    callPerMinuteMicros: card.callPerMinuteMicros,
    pulseSeconds: card.pulseSeconds,
    aiPerMinuteMicros: card.aiPerMinuteMicros,
    ttsPer1kCharsMicros: card.ttsPer1kCharsMicros,
    commissionBps: card.commissionBps,
    billUnansweredAttempts: card.billUnansweredAttempts,
    aiTextPer1kTokensMicros: card.aiTextPer1kTokensMicros,
    embeddingPer1kTokensMicros: card.embeddingPer1kTokensMicros,
    source: card.source,
    effectiveFrom: card.effectiveFrom.toISOString(),
  };
};

export const estimate = async (req: Request, body: z.infer<typeof EstimateBody>) => {
  const { accountId } = tenantFilter(req);
  const [card, wallet] = await Promise.all([
    effectiveRateCard(accountId),
    getOrCreateWallet(accountId),
  ]);
  return {
    ...estimateCampaign(card, body),
    holdPerCallMicros: holdEstimate(card),
    availableMicros: availableMicros(snap(wallet)),
  };
};
