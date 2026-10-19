import { BILLING_LIMITS, CALL_LIMITS } from '../../config/limits';
import { callCharge, holdEstimate, type CallUsage } from '../../core/billing/pricing';
import { effectiveRateCard } from '../../core/billing/rates';
import type { CallCost } from '../../db/models/call.model';
import { toObjectId } from '../../shared/auth/tenant';

import type { CallBillingPort } from './billing';

/**
 * May the dry run go on spending `micros` more (the campaign's virtual
 * balance)? Single dry-run calls pass `() => true`.
 */
export type VirtualGate = (micros: number) => Promise<boolean>;

/**
 * Billing of a dry-run call (PHASE_8_PROMPT §1 "Virtual billing"): priced like
 * a phone call with the account's rate card, **never charged** — no hold, no
 * ledger row. The wallet gate is virtual, so "money runs out" can be rehearsed
 * (the session's polite `wallet_empty` end works the same).
 */
export class VirtualCallBilling implements CallBillingPort {
  readonly holdId = null;
  private coveredSec = BILLING_LIMITS.callHoldMinutes * 60;

  constructor(
    private readonly accountId: string,
    private readonly gate: VirtualGate,
  ) {}

  private async card() {
    const id = toObjectId(this.accountId);
    if (!id) throw new Error('Invalid id');
    return effectiveRateCard(id);
  }

  /** The virtual "hold" before dialing: is there room for one more call? */
  async canStart(): Promise<boolean> {
    return this.gate(holdEstimate(await this.card(), BILLING_LIMITS.callHoldMinutes, true));
  }

  needsExtension(elapsedSec: number): boolean {
    return this.coveredSec - elapsedSec < CALL_LIMITS.holdLowWaterSec;
  }

  async extend(): Promise<boolean> {
    const ok = await this.gate(
      holdEstimate(await this.card(), BILLING_LIMITS.callHoldExtendMinutes, true),
    );
    if (ok) this.coveredSec += BILLING_LIMITS.callHoldExtendMinutes * 60;
    return ok;
  }

  async settle(
    usage: Omit<CallUsage, 'telephony'>,
  ): Promise<{ ledgerEntryId: string | null; cost: CallCost }> {
    const charge = callCharge(await this.card(), { ...usage, telephony: true });
    const b = charge.breakdown;
    return {
      ledgerEntryId: null,
      cost: {
        telephonyMicros: b.telephonyMicros,
        aiMicros: b.aiMicros,
        ttsMicros: b.ttsMicros,
        commissionMicros: b.commissionMicros,
        totalMicros: charge.totalMicros,
      },
    };
  }

  release(): Promise<void> {
    return Promise.resolve();
  }
}
