import {
  MockPaymentRecordModel,
  type MockPaymentRecordDoc,
} from '../../db/models/mock-payment-record.model';
import { MONEY_SCALE } from '../../shared/money';
import { addDays, ymdInZone } from '../../shared/time';

/** Default answer amount when no record is seeded (₹2,500). */
export const MOCK_DEFAULT_AMOUNT_MICROS = 2_500 * MONEY_SCALE;
const ZONE = 'Asia/Kolkata';

export interface MockPaymentStatus {
  found: boolean;
  status: MockPaymentRecordDoc['status'];
  amountRupees: number;
  paidOn: string | null;
  loanId: string | null;
}

/** `' 919…'` (a `+` decoded as a space) / `919…` → `+919…`. */
export const normalizeMockPhone = (input: string): string => {
  const trimmed = input.trim();
  return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
};

/**
 * DEV ONLY mock of a client's payment API. Seeded records win; otherwise the
 * last digit decides: even → paid yesterday (IST), odd → unpaid. ₹2,500 either way.
 */
export const mockPaymentStatus = async (
  phone: string,
  loanId: string | null,
  now: Date = new Date(),
): Promise<MockPaymentStatus> => {
  const record = await MockPaymentRecordModel.findOne({
    phoneE164: phone,
    ...(loanId ? { loanId } : {}),
  })
    .sort({ updatedAt: -1 })
    .lean<MockPaymentRecordDoc>();
  if (record) {
    return {
      found: true,
      status: record.status,
      amountRupees: record.amountMicros / MONEY_SCALE,
      paidOn: record.paidOn,
      loanId: record.loanId ?? loanId,
    };
  }
  const paid = Number(phone.at(-1)) % 2 === 0;
  return {
    found: false,
    status: paid ? 'paid' : 'unpaid',
    amountRupees: MOCK_DEFAULT_AMOUNT_MICROS / MONEY_SCALE,
    paidOn: paid ? addDays(ymdInZone(now, ZONE), -1) : null,
    loanId,
  };
};
