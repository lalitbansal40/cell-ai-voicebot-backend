import type { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { InvoiceModel, type InvoiceDoc } from '../../db/models/invoice.model';
import { TopupOrderModel, type TopupOrderDoc } from '../../db/models/topup-order.model';
import { withTransaction } from '../../db/transaction';
import { recordAudit, type AuditActorInput } from '../../modules/audit/audit.service';
import { notify } from '../../modules/notifications/notifications.service';
import { ConflictError } from '../../shared/errors/app-error';
import { gstStateName } from '../../shared/gst-states';
import { getLogger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import type { ProviderPayment } from '../payments/types';

import { credit } from './engine';
import { publishWalletChange, type WalletChange } from './events';
import { nextInvoiceNumber } from './invoice-number';
import type { BillingJobs } from './jobs';
import { getOrCreateWallet } from './wallets';

export interface CreditTopupResult {
  order: TopupOrderDoc;
  invoice: InvoiceDoc | null;
  /** `false` when the order was already paid (verify + webhook both arrived). */
  credited: boolean;
}

/**
 * Marks a top-up order paid and credits the wallet — ONE transaction: order
 * `created|expired → paid`, ledger credit (`topup:<orderId>`), invoice number +
 * invoice row. Shared by checkout verify and the webhook; whichever comes
 * second is a no-op. Side effects (WS, invoice render, audit, bell) after commit.
 */
export const creditTopup = async ({
  orderId,
  payment,
  actor,
  jobs,
  ip = null,
}: {
  orderId: Types.ObjectId;
  payment: ProviderPayment;
  actor: AuditActorInput;
  jobs: BillingJobs;
  ip?: string | null;
}): Promise<CreditTopupResult> => {
  const env = getEnv();
  // The wallet must exist before the transaction starts: a transaction reads
  // a snapshot, so a wallet created outside it meanwhile would be invisible.
  const pending = await TopupOrderModel.findById(orderId)
    .select({ accountId: 1 })
    .lean<{ accountId: Types.ObjectId }>();
  if (pending) await getOrCreateWallet(pending.accountId);
  const out = await withTransaction(async (session) => {
    const paidAt = new Date();
    const order = await TopupOrderModel.findOneAndUpdate(
      { _id: orderId, status: { $in: ['created', 'expired'] } },
      {
        $set: {
          status: 'paid',
          providerPaymentId: payment.id,
          paidAt,
          rawProviderStatus: payment.status,
        },
      },
      { session, returnDocument: 'after' },
    ).lean<TopupOrderDoc>();
    if (!order) {
      const current = await TopupOrderModel.findById(orderId)
        .session(session)
        .lean<TopupOrderDoc>();
      if (current?.status === 'paid') {
        const invoice = current.invoiceId
          ? await InvoiceModel.findById(current.invoiceId).session(session).lean<InvoiceDoc>()
          : null;
        return { order: current, invoice, credited: false, change: null as WalletChange | null };
      }
      throw new ConflictError('CONFLICT_INVALID_STATE', 'This top-up can no longer be paid');
    }
    const credited = await credit(
      {
        accountId: order.accountId,
        type: 'topup',
        amountMicros: order.baseMicros,
        ref: { type: 'topup', id: order._id.toString() },
        idempotencyKey: `topup:${order._id.toString()}`,
        createdBy: order.createdBy,
      },
      { session },
    );
    const entry = credited.entries[0];
    if (!entry) throw new Error('top-up credit produced no ledger row');
    const { number, fy } = await nextInvoiceNumber(paidAt, session);
    const [invoice] = await InvoiceModel.create(
      [
        {
          accountId: order.accountId,
          number,
          fy,
          topupOrderId: order._id,
          ledgerEntryId: entry._id,
          seller: {
            name: env.BILLING_SELLER_NAME,
            address: env.BILLING_SELLER_ADDRESS,
            gstin: env.BILLING_SELLER_GSTIN ?? null,
            stateCode: env.BILLING_SELLER_STATE_CODE,
          },
          buyer: order.buyer,
          placeOfSupply: {
            stateCode: order.buyer.stateCode,
            stateName: gstStateName(order.buyer.stateCode),
          },
          sacCode: env.BILLING_SAC_CODE,
          amounts: {
            baseMicros: order.baseMicros,
            cgstMicros: order.cgstMicros,
            sgstMicros: order.sgstMicros,
            igstMicros: order.igstMicros,
            taxMicros: order.taxMicros,
            totalMicros: order.totalMicros,
          },
          paymentId: payment.id,
          issuedAt: paidAt,
          status: 'rendering',
        },
      ],
      { session },
    );
    if (!invoice) throw new Error('invoice insert returned nothing');
    const final = await TopupOrderModel.findOneAndUpdate(
      { _id: order._id },
      { $set: { ledgerEntryId: entry._id, invoiceId: invoice._id } },
      { session, returnDocument: 'after' },
    ).lean<TopupOrderDoc>();
    return {
      order: final ?? order,
      invoice: invoice.toObject({ transform: false }),
      credited: true,
      change: credited.change ?? null,
    };
  });

  if (out.credited) {
    if (out.change) await publishWalletChange(out.change);
    const accountId = out.order.accountId;
    if (out.invoice) {
      await jobs
        .enqueue('invoice.render', {
          accountId: accountId.toString(),
          invoiceId: out.invoice._id.toString(),
        })
        .catch((err: unknown) =>
          getLogger().error(
            { err, invoiceId: out.invoice?._id.toString() },
            'billing: invoice render enqueue failed',
          ),
        );
    }
    await recordAudit({
      accountId,
      actor,
      action: 'wallet.topup_paid',
      target: { type: 'topup_order', id: out.order._id.toString() },
      meta: { amountMicros: out.order.baseMicros, invoiceNumber: out.invoice?.number ?? null },
      ip,
    });
    await notify({
      accountId,
      permission: 'wallet.read',
      type: 'wallet.topup_paid',
      title: 'Money added to the wallet',
      body: `${formatInr(out.order.baseMicros)} was added (paid ${formatInr(out.order.totalMicros)} incl. GST).`,
      link: '/wallet?tab=invoices',
    });
  }
  return { order: out.order, invoice: out.invoice, credited: out.credited };
};
