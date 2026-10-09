import PDFDocument from 'pdfkit';

import type { InvoiceDoc } from '../../db/models/invoice.model';
import { assetPath } from '../../shared/assets';
import { gstStateName } from '../../shared/gst-states';
import { amountInWords, formatInr } from '../../shared/money';

const REGULAR = assetPath('fonts', 'NotoSans-Regular.ttf');
const BOLD = assetPath('fonts', 'NotoSans-Bold.ttf');
const MARGIN = 40;

/** `09 Oct 2026` in IST. */
export const invoiceDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);

/**
 * GST tax invoice for a wallet recharge (PHASE_4_PROMPT §1 "Invoice PDF"):
 * A4, Noto Sans (₹), seller / buyer / place of supply / SAC / CGST + SGST or
 * IGST / amount in words. Rendered in the `invoice.render` job only.
 */
export const renderInvoicePdf = (invoice: InvoiceDoc): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      info: { Title: `Invoice ${invoice.number}`, Author: invoice.seller.name },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('regular', REGULAR);
    doc.registerFont('bold', BOLD);

    const width = doc.page.width - MARGIN * 2;
    const a = invoice.amounts;

    doc.font('bold').fontSize(18).text('TAX INVOICE', { align: 'center' });
    doc.moveDown(0.8);

    const top = doc.y;
    doc
      .font('bold')
      .fontSize(11)
      .text(invoice.seller.name, MARGIN, top, { width: width / 2 - 10 });
    doc
      .font('regular')
      .fontSize(9)
      .text(invoice.seller.address, { width: width / 2 - 10 });
    if (invoice.seller.gstin) doc.text(`GSTIN: ${invoice.seller.gstin}`);
    doc.text(`State: ${gstStateName(invoice.seller.stateCode)} (${invoice.seller.stateCode})`);
    const leftBottom = doc.y;

    const right = MARGIN + width / 2 + 10;
    doc.font('regular').fontSize(9);
    doc.text(`Invoice no: ${invoice.number}`, right, top, { width: width / 2 - 10 });
    doc.text(`Date: ${invoiceDate(invoice.issuedAt)}`);
    doc.text(
      `Place of supply: ${invoice.placeOfSupply.stateName} (${invoice.placeOfSupply.stateCode})`,
    );
    doc.text(`Payment id: ${invoice.paymentId}`);
    doc.y = Math.max(leftBottom, doc.y) + 14;

    doc.font('bold').fontSize(10).text('Bill to', MARGIN);
    doc.font('regular').fontSize(9).text(invoice.buyer.legalName);
    doc.text(
      [
        invoice.buyer.addressLine1,
        invoice.buyer.addressLine2,
        `${invoice.buyer.city} ${invoice.buyer.pin}`,
      ]
        .filter(Boolean)
        .join(', '),
    );
    doc.text(`${gstStateName(invoice.buyer.stateCode)} (${invoice.buyer.stateCode})`);
    if (invoice.buyer.gstin) doc.text(`GSTIN: ${invoice.buyer.gstin}`);
    doc.text(invoice.buyer.email);
    doc.moveDown(1);

    // layout in points (percent of the text width), not money
    const pct = (n: number) => (width * n) / 100;
    const cols = [MARGIN, MARGIN + pct(52), MARGIN + pct(68)];
    const row = (label: string, sac: string, amount: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? 'bold' : 'regular').fontSize(9);
      doc.text(label, cols[0], y, { width: pct(50) });
      doc.text(sac, cols[1], y, { width: pct(15) });
      doc.text(amount, cols[2], y, { width: pct(32), align: 'right' });
      doc.moveDown(0.4);
    };
    row('Description', 'SAC', 'Amount', true);
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + width, doc.y)
      .stroke();
    doc.moveDown(0.3);
    row('Prepaid wallet recharge', invoice.sacCode, formatInr(a.baseMicros));
    row('Taxable value', '', formatInr(a.baseMicros));
    if (a.igstMicros > 0) {
      row('IGST @ 18%', '', formatInr(a.igstMicros));
    } else {
      row('CGST @ 9%', '', formatInr(a.cgstMicros));
      row('SGST @ 9%', '', formatInr(a.sgstMicros));
    }
    doc
      .moveTo(MARGIN, doc.y)
      .lineTo(MARGIN + width, doc.y)
      .stroke();
    doc.moveDown(0.3);
    row('Total', '', formatInr(a.totalMicros), true);
    doc.moveDown(0.6);
    doc
      .font('regular')
      .fontSize(9)
      .text(`Amount in words: ${amountInWords(a.totalMicros)}`, MARGIN);

    doc
      .fontSize(8)
      .fillColor('#555555')
      .text('Computer generated invoice — no signature required.', MARGIN, doc.page.height - 70, {
        width,
        align: 'center',
      });
    doc.end();
  });
