import type { ClientSession } from 'mongoose';

import { getEnv } from '../../config/env';
import { InvoiceCounterModel } from '../../db/models/invoice-counter.model';

const two = (n: number) => String(n % 100).padStart(2, '0');

/** Indian financial year of `date` in IST (Apr–Mar): `26-27`. */
export const financialYear = (date: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const start = month >= 4 ? year : year - 1;
  return `${two(start)}-${two(start + 1)}`;
};

/**
 * Next GST invoice number `CAV/26-27/000001` — one consecutive series per
 * financial year, allocated inside the caller's transaction (an aborted
 * transaction consumes no number).
 */
export const nextInvoiceNumber = async (
  date: Date,
  session: ClientSession,
): Promise<{ number: string; fy: string }> => {
  const fy = financialYear(date);
  const counter = await InvoiceCounterModel.findOneAndUpdate(
    { _id: fy },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  const seq = counter?.seq ?? 1;
  return { number: `${getEnv().BILLING_INVOICE_PREFIX}/${fy}/${String(seq).padStart(6, '0')}`, fy };
};
