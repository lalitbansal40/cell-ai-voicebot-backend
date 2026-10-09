import { BILLING_LIMITS } from '../../config/limits';
import type { TopupAmounts } from '../../db/models/topup-order.model';
import { assertMicros, mulBps, roundToPaise } from '../../shared/money';

/**
 * GST on a wallet recharge (PHASE_4_PLAN §1d): 18 % on top of the base.
 * Same state → CGST 9 % + SGST 9 %, else IGST 18 %; each component rounded
 * to whole paise.
 */
export const computeTopupTax = (
  baseMicros: number,
  sellerStateCode: string,
  buyerStateCode: string,
): TopupAmounts => {
  assertMicros(baseMicros);
  const rate = BILLING_LIMITS.gstRateBps;
  let cgstMicros = 0;
  let sgstMicros = 0;
  let igstMicros = 0;
  if (sellerStateCode === buyerStateCode) {
    cgstMicros = roundToPaise(mulBps(baseMicros, rate / 2));
    sgstMicros = roundToPaise(mulBps(baseMicros, rate / 2));
  } else {
    igstMicros = roundToPaise(mulBps(baseMicros, rate));
  }
  const taxMicros = cgstMicros + sgstMicros + igstMicros;
  return {
    baseMicros,
    cgstMicros,
    sgstMicros,
    igstMicros,
    taxMicros,
    totalMicros: baseMicros + taxMicros,
  };
};
