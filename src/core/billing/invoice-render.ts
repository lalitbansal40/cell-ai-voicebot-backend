import type { Job } from 'bullmq';
import { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { AccountModel } from '../../db/models/account.model';
import { InvoiceModel, type InvoiceDoc } from '../../db/models/invoice.model';
import { UserModel } from '../../db/models/user.model';
import { getLogger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import { getEmail } from '../email';
import { storageKey, type StorageProvider } from '../storage';

import { invoiceDate, renderInvoicePdf } from './invoice-pdf';
import type { BillingJobData } from './jobs';

const sendReceipt = async (invoice: InvoiceDoc): Promise<void> => {
  const account = await AccountModel.findById(invoice.accountId)
    .select({ name: 1, ownerId: 1 })
    .lean<{ name: string; ownerId?: Types.ObjectId | null }>();
  const owner = account?.ownerId
    ? await UserModel.findById(account.ownerId).select({ email: 1 }).lean<{ email: string }>()
    : null;
  const recipients = [
    ...new Set(
      [invoice.buyer.email, owner?.email]
        .filter((e): e is string => Boolean(e))
        .map((e) => e.toLowerCase()),
    ),
  ];
  const vars = {
    accountName: account?.name ?? invoice.buyer.legalName,
    amount: formatInr(invoice.amounts.baseMicros),
    tax: formatInr(invoice.amounts.taxMicros),
    total: formatInr(invoice.amounts.totalMicros),
    invoiceNumber: invoice.number,
    date: invoiceDate(invoice.issuedAt),
    invoicesUrl: `${getEnv().FRONTEND_URL.replace(/\/+$/, '')}/wallet?tab=invoices`,
  };
  for (const to of recipients) {
    await getEmail().enqueue('wallet.receipt', to, vars, {
      dedupeKey: `receipt:${invoice._id.toString()}:${to}`,
    });
  }
};

/** Storage key of an invoice PDF (`/` in the number → `-`). */
export const invoiceFileKey = (invoice: Pick<InvoiceDoc, 'accountId' | 'number'>): string =>
  storageKey({
    accountId: invoice.accountId.toString(),
    area: 'invoices',
    id: invoice.number.replace(/\//g, '-'),
    ext: 'pdf',
  });

/**
 * `invoice.render`: PDF → storage → `ready`, then the receipt email (first
 * render only). Re-rendering keeps the number. On the last failed attempt
 * the invoice is marked `failed`.
 */
export const renderInvoice = async (
  data: BillingJobData['invoice.render'],
  { storage }: { storage?: StorageProvider },
  job?: Pick<Job, 'attemptsMade' | 'opts'>,
): Promise<{ rendered: number }> => {
  const invoice = await InvoiceModel.findOne({
    _id: new Types.ObjectId(data.invoiceId),
    accountId: new Types.ObjectId(data.accountId),
  }).lean<InvoiceDoc>();
  if (!invoice) {
    getLogger().warn({ invoiceId: data.invoiceId }, 'billing: invoice to render not found');
    return { rendered: 0 };
  }
  try {
    if (!storage) throw new Error('Invoice rendering needs file storage');
    const pdf = await renderInvoicePdf(invoice);
    const key = invoiceFileKey(invoice);
    await storage.put(key, pdf, { contentType: 'application/pdf' });
    await InvoiceModel.updateOne(
      { _id: invoice._id },
      { $set: { status: 'ready', pdfFileKey: key } },
    );
    if (invoice.status !== 'ready') await sendReceipt(invoice);
    return { rendered: 1 };
  } catch (err) {
    const last = !job || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (last) {
      await InvoiceModel.updateOne(
        { _id: invoice._id, status: { $ne: 'ready' } },
        { $set: { status: 'failed' } },
      );
    }
    getLogger().error({ err, invoiceId: data.invoiceId, last }, 'billing: invoice render failed');
    throw err;
  }
};
