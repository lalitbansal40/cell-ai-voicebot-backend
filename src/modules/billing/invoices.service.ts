import type { Types } from 'mongoose';
import type { z } from 'zod';

import { BILLING_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { InvoiceModel, type InvoiceDoc } from '../../db/models/invoice.model';
import { ConflictError, NotFoundError } from '../../shared/errors/app-error';

import type { ListInvoicesQuery } from './invoices.schema';

const view = (i: InvoiceDoc) => ({
  id: i._id.toString(),
  number: i.number,
  fy: i.fy,
  status: i.status,
  seller: {
    name: i.seller.name,
    address: i.seller.address,
    gstin: i.seller.gstin ?? null,
    stateCode: i.seller.stateCode,
  },
  buyer: {
    legalName: i.buyer.legalName,
    email: i.buyer.email,
    addressLine1: i.buyer.addressLine1,
    addressLine2: i.buyer.addressLine2 ?? null,
    city: i.buyer.city,
    stateCode: i.buyer.stateCode,
    pin: i.buyer.pin,
    gstin: i.buyer.gstin ?? null,
  },
  placeOfSupply: i.placeOfSupply,
  sacCode: i.sacCode,
  amounts: i.amounts,
  paymentId: i.paymentId,
  topupOrderId: i.topupOrderId.toString(),
  issuedAt: i.issuedAt.toISOString(),
});

export const listInvoices = async (
  accountId: Types.ObjectId,
  query: z.infer<typeof ListInvoicesQuery>,
) => {
  const [rows, total] = await Promise.all([
    InvoiceModel.find({ accountId })
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<InvoiceDoc[]>(),
    InvoiceModel.countDocuments({ accountId }),
  ]);
  return {
    items: rows.map(view),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
};

const own = async (accountId: Types.ObjectId, id: string) => {
  const invoice = await InvoiceModel.findOne({ _id: id, accountId }).lean<InvoiceDoc>();
  if (!invoice) throw new NotFoundError('Invoice not found');
  return invoice;
};

export const getInvoice = async (accountId: Types.ObjectId, id: string) =>
  view(await own(accountId, id));

/** Fresh signed URL (15 min). The PDF is never served without a signature. */
export const invoiceDownload = async (
  accountId: Types.ObjectId,
  id: string,
  storage?: StorageProvider,
) => {
  const invoice = await own(accountId, id);
  if (invoice.status !== 'ready' || !invoice.pdfFileKey || !storage) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The invoice PDF is not ready yet');
  }
  return {
    url: await storage.signedUrl(invoice.pdfFileKey, {
      expiresInSec: BILLING_LIMITS.invoiceUrlTtlSec,
    }),
    expiresInSec: BILLING_LIMITS.invoiceUrlTtlSec,
  };
};
