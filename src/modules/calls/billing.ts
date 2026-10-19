import { BILLING_LIMITS, CALL_LIMITS } from '../../config/limits';
import {
  chargeUsage,
  extendHold,
  holdForCall,
  releaseHold,
  settleCall,
} from '../../core/billing/engine';
import { holdEstimate, type CallUsage } from '../../core/billing/pricing';
import { effectiveRateCard } from '../../core/billing/rates';
import type { CallCost } from '../../db/models/call.model';
import { toObjectId } from '../../shared/auth/tenant';

const oid = (id: string) => {
  const value = toObjectId(id);
  if (!value) throw new Error('Invalid id');
  return value;
};

/** What a call session needs from billing (real wallet or a dry run's virtual one). */
export interface CallBillingPort {
  readonly holdId: string | null;
  needsExtension(elapsedSec: number): boolean;
  /** False when no more money may be spent — the call must end politely. */
  extend(): Promise<boolean>;
  settle(
    usage: Omit<CallUsage, 'telephony'>,
  ): Promise<{ ledgerEntryId: string | null; cost: CallCost }>;
  release(reason: string): Promise<void>;
}

/** Wallet side of one call: hold at start, extend while it runs, settle or release at the end. */
export class CallBilling implements CallBillingPort {
  holdId: string | null = null;
  private coveredSec = 0;
  private extensions = 0;

  constructor(
    private readonly accountId: string,
    private readonly callId: string,
    /** False for web test calls (no carrier minutes). */
    private readonly telephony: boolean,
  ) {}

  /** Throws `WALLET_INSUFFICIENT_BALANCE` / `WALLET_BUDGET_EXCEEDED` when the wallet can't hold it. */
  async hold(): Promise<string> {
    const card = await effectiveRateCard(oid(this.accountId));
    const result = await holdForCall({
      accountId: this.accountId,
      ref: { type: 'call', id: this.callId },
      idempotencyKey: `hold:${this.callId}`,
      estimateMicros: holdEstimate(card, BILLING_LIMITS.callHoldMinutes, this.telephony),
    });
    const row = result.entries[0];
    if (!row) throw new Error('hold produced no ledger row');
    this.holdId = row._id.toString();
    this.coveredSec = BILLING_LIMITS.callHoldMinutes * 60;
    return this.holdId;
  }

  needsExtension(elapsedSec: number): boolean {
    return this.holdId !== null && this.coveredSec - elapsedSec < CALL_LIMITS.holdLowWaterSec;
  }

  /** False when the wallet can't pay more — the call must end politely. */
  async extend(): Promise<boolean> {
    if (!this.holdId) return false;
    this.extensions += 1;
    const card = await effectiveRateCard(oid(this.accountId));
    const result = await extendHold({
      accountId: this.accountId,
      holdId: this.holdId,
      idempotencyKey: `extend:${this.callId}:${String(this.extensions)}`,
      addMicros: holdEstimate(card, BILLING_LIMITS.callHoldExtendMinutes, this.telephony),
    });
    if (!result.ok) return false;
    this.coveredSec += BILLING_LIMITS.callHoldExtendMinutes * 60;
    return true;
  }

  async settle(
    usage: Omit<CallUsage, 'telephony'>,
  ): Promise<{ ledgerEntryId: string | null; cost: CallCost }> {
    if (!this.holdId) throw new Error('No hold to settle');
    const result = await settleCall({
      accountId: this.accountId,
      holdId: this.holdId,
      usage: { ...usage, telephony: this.telephony },
    });
    const charge = result.entries.find((e) => e.type === 'call_charge');
    const b = charge?.breakdown;
    return {
      ledgerEntryId: charge ? charge._id.toString() : null,
      cost: {
        telephonyMicros: b?.telephonyMicros ?? 0,
        aiMicros: b?.aiMicros ?? 0,
        ttsMicros: b?.ttsMicros ?? 0,
        commissionMicros: b?.commissionMicros ?? 0,
        totalMicros: charge?.amountMicros ?? 0,
      },
    };
  }

  async release(reason: string): Promise<void> {
    if (this.holdId) await releaseHold({ accountId: this.accountId, holdId: this.holdId, reason });
  }
}

/** Text-model / embedding charges inside a call (AI intents, knowledge search). */
export const chargeCallUsage = (input: {
  accountId: string;
  callId: string;
  key: string;
  amountMicros: number;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  model: string;
}) =>
  chargeUsage({
    accountId: input.accountId,
    type: 'ai_charge',
    amountMicros: input.amountMicros,
    breakdown: {
      aiMicros: input.amountMicros,
      ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
      ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
      ...(input.embeddingTokens !== undefined ? { embeddingTokens: input.embeddingTokens } : {}),
      model: input.model,
      kind: 'call',
    },
    ref: { type: 'call', id: input.callId },
    idempotencyKey: `callusage:${input.callId}:${input.key}`,
  });
