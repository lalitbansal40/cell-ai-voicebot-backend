import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { APP_NAME, renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

export interface WalletLowBalanceVars {
  accountName: string;
  /** Formatted, e.g. `₹120.00`. */
  available: string;
  threshold: string;
  /** Balance reached 0 — new calls are refused until a top-up. */
  exhausted: boolean;
  walletUrl: string;
}

/** Low balance / balance exhausted (`wallet.low_balance`). No amounts of other accounts. */
export const walletLowBalance = ({
  accountName,
  available,
  threshold,
  exhausted,
  walletUrl,
}: WalletLowBalanceVars): RenderedEmail => {
  const subject = exhausted
    ? `${accountName}: wallet balance used up — calls are paused`
    : `${accountName}: wallet balance is low`;
  const lead = exhausted
    ? `The wallet of ${accountName} has no balance left (${available} available). New calls are refused until you add money.`
    : `The wallet of ${accountName} has ${available} available — below your alert level of ${threshold}.`;
  return {
    subject,
    html: renderLayout({
      title: subject,
      bodyHtml: `<p>${escapeHtml(lead)}</p>${buttonHtml(walletUrl, 'Add money')}<p>You get at most one such email a day. Change the alert level in ${escapeHtml(APP_NAME)} → Wallet.</p>`,
    }),
    text: renderTextLayout(
      `${lead}\n\nAdd money: ${walletUrl}\n\nYou get at most one such email a day. Change the alert level in ${APP_NAME} → Wallet.`,
    ),
  };
};

export interface WalletReceiptVars {
  accountName: string;
  /** Formatted amounts, e.g. `₹1,000.00`. */
  amount: string;
  tax: string;
  total: string;
  invoiceNumber: string;
  /** `09 Oct 2026` (IST). */
  date: string;
  invoicesUrl: string;
}

/** Payment receipt after a top-up (`wallet.receipt`) — link only, no attachment. */
export const walletReceipt = ({
  accountName,
  amount,
  tax,
  total,
  invoiceNumber,
  date,
  invoicesUrl,
}: WalletReceiptVars): RenderedEmail => {
  const subject = `Payment received — invoice ${invoiceNumber}`;
  const lines = [
    `We received ${total} for the wallet of ${accountName} on ${date}.`,
    `Wallet credit: ${amount}`,
    `GST: ${tax}`,
    `Invoice: ${invoiceNumber}`,
  ];
  return {
    subject,
    html: renderLayout({
      title: subject,
      bodyHtml: `<p>${escapeHtml(lines[0] ?? '')}</p><p>${lines
        .slice(1)
        .map((l) => escapeHtml(l))
        .join('<br>')}</p>${buttonHtml(invoicesUrl, 'View invoice')}`,
    }),
    text: renderTextLayout(`${lines.join('\n')}\n\nView invoice: ${invoicesUrl}`),
  };
};
