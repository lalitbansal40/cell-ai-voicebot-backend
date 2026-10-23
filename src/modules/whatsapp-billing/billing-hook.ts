import type { Types } from 'mongoose';

import { captureWhatsApp, chargeWhatsAppLate, releaseWhatsApp } from '../../core/billing/engine';
import type { LedgerBreakdown } from '../../db/models/ledger-entry.model';
import {
  MessageModel,
  type MessageBilling,
  type MessageBillingStatus,
  type MessageDoc,
  type MessagePricing,
  type MessageStatus,
} from '../../db/models/message.model';
import { getLogger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import { notify } from '../notifications/notifications.service';
import { TEMPLATE_NOTIFICATIONS } from '../templates/notification-types';

/** What the inbox status pipeline hands over (ids + Meta's pricing — no texts). */
export interface BillingStatusInput {
  accountId: Types.ObjectId;
  messageId: Types.ObjectId;
  status: MessageStatus;
  pricing: MessagePricing | null;
}

export type BillingOutcome = 'none' | 'captured' | 'released' | 'late_charged' | 'ignored';

const FINAL: readonly MessageBillingStatus[] = ['captured', 'late_charged', 'waived'];

export const breakdownOf = (b: MessageBilling, pricingType: string | null): LedgerBreakdown => ({
  kind: 'whatsapp',
  waCategory: b.category,
  waMarket: b.market,
  metaCostMicros: b.metaCostMicros,
  markupMicros: Math.max(0, b.priceMicros - b.metaCostMicros),
  platformFeeMicros: 0,
  ...(pricingType ? { waPricingType: pricingType } : {}),
});

/** Moves `billing.status` only from the status we read (a parallel status loses). */
const setBilling = (
  m: Pick<MessageDoc, '_id'>,
  from: MessageBillingStatus,
  set: Partial<MessageBilling>,
) =>
  MessageModel.updateOne(
    { _id: m._id, 'billing.status': from },
    { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`billing.${k}`, v])) },
  );

const lateChargeBell = async (accountId: Types.ObjectId, amountMicros: number) => {
  const spec = TEMPLATE_NOTIFICATIONS['wallet.whatsapp_late_charge'];
  await notify({
    accountId,
    permission: 'wallet.topup',
    type: 'wallet.whatsapp_late_charge',
    title: spec.title,
    body: `WhatsApp billed a message after its hold ended (${formatInr(amountMicros)}). Your balance is below zero — add money to keep sending.`,
    link: spec.link(),
  });
};

/**
 * PHASE_11_PROMPT §1 "Billing hook in statuses": the first decisive signal wins —
 * `billable: true` captures the held price, `billable: false` or `failed` releases it,
 * a billable status after a release charges late (once). Later contradicting signals
 * are ignored (logged with ids only). Idempotent through the engine's keys.
 */
export const onMessageStatus = async (input: BillingStatusInput): Promise<BillingOutcome> => {
  const m = await MessageModel.findOne({ _id: input.messageId, accountId: input.accountId })
    .select({ billing: 1, accountId: 1 })
    .lean<Pick<MessageDoc, '_id' | 'accountId' | 'billing'>>();
  const b = m?.billing;
  if (!m || !b || b.status === 'none') return 'none';
  const billable = input.pricing?.billable;
  const decisive = billable === true || billable === false || input.status === 'failed';
  if (!decisive) return 'none';
  const now = new Date();
  const metaCategory = input.pricing?.category ?? null;
  const facts = {
    billable: billable ?? false,
    pricingType: input.pricing?.type ?? null,
    metaCategory,
    categoryMismatch: Boolean(metaCategory && metaCategory !== b.category),
    at: now,
  };
  const messageId = m._id.toString();

  if (b.status === 'held' && b.holdId) {
    if (billable === true) {
      await captureWhatsApp({
        accountId: m.accountId,
        holdId: b.holdId,
        messageId,
        ...(facts.categoryMismatch
          ? {
              note: `Meta billed ${String(metaCategory)}; charged the ${b.category} price fixed at send`,
            }
          : {}),
      });
      await setBilling(m, 'held', { ...facts, status: 'captured' });
      return 'captured';
    }
    await releaseWhatsApp({
      accountId: m.accountId,
      holdId: b.holdId,
      reason: billable === false ? 'not_billable' : 'failed',
    });
    await setBilling(m, 'held', { ...facts, status: 'released' });
    return 'released';
  }

  if (b.status === 'released' && billable === true) {
    // Meta billed after we gave the hold back (72 h reaper, an early failed status)
    const res = await chargeWhatsAppLate({
      accountId: m.accountId,
      messageId,
      amountMicros: b.priceMicros,
      breakdown: breakdownOf(b, facts.pricingType),
      ref: { type: 'whatsapp_message', id: messageId },
    });
    await setBilling(m, 'released', { ...facts, status: 'late_charged' });
    if (!res.replay && res.wallet.balanceMicros < 0) {
      await lateChargeBell(m.accountId, b.priceMicros);
    }
    return 'late_charged';
  }

  if (FINAL.includes(b.status) && billable === false) {
    getLogger().info(
      { messageId, billingStatus: b.status },
      'whatsapp billing: contradicting status ignored',
    );
  }
  return 'ignored';
};

/** The hook the inbox context carries (status pipeline → billing, no import cycle). */
export const createWhatsAppBillingHook = () => ({ onStatus: onMessageStatus });
