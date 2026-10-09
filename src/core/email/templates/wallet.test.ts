import { describe, expect, it } from 'vitest';

import { renderTemplate } from './index';

describe('wallet email templates', () => {
  it('escapes the account name in the low-balance mail and has a text part', () => {
    const mail = renderTemplate('wallet.low_balance', {
      accountName: '<script>x</script> Co',
      available: '₹90.00',
      threshold: '₹100.00',
      exhausted: false,
      walletUrl: 'http://localhost:3100/wallet',
    });
    expect(mail.subject).toBe('<script>x</script> Co: wallet balance is low');
    expect(mail.html).not.toContain('<script>x');
    expect(mail.html).toContain('&lt;script&gt;');
    expect(mail.text).toContain('₹90.00 available — below your alert level of ₹100.00');
    const exhausted = renderTemplate('wallet.low_balance', {
      accountName: 'Co',
      available: '₹0.00',
      threshold: '₹100.00',
      exhausted: true,
      walletUrl: 'http://x/wallet',
    });
    expect(exhausted.subject).toMatch(/used up/);
    expect(exhausted.text).toContain('New calls are refused');
  });

  it('renders the receipt without an attachment', () => {
    const mail = renderTemplate('wallet.receipt', {
      accountName: 'Test & Co',
      amount: '₹1,000.00',
      tax: '₹180.00',
      total: '₹1,180.00',
      invoiceNumber: 'CAV/26-27/000001',
      date: '09 Oct 2026',
      invoicesUrl: 'http://localhost:3100/wallet?tab=invoices',
    });
    expect(mail.subject).toBe('Payment received — invoice CAV/26-27/000001');
    expect(mail.html).toContain('Test &amp; Co');
    expect(mail.text).toContain(
      'Wallet credit: ₹1,000.00\nGST: ₹180.00\nInvoice: CAV/26-27/000001',
    );
  });
});
