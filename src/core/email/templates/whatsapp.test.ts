import { describe, expect, it } from 'vitest';

import { renderTemplate } from './index';

const vars = {
  accountName: 'Acme <b>Loans</b>',
  label: 'Support & Sales',
  phoneLast4: '2345',
  reason: 'Access was removed in Facebook',
  numbersUrl: 'http://localhost:3150/whatsapp/numbers',
};

describe('WhatsApp email templates', () => {
  it('needs reconnect: escaped names, last 4 digits only, link and text part', () => {
    const mail = renderTemplate('whatsapp.needs_reconnect', vars);
    expect(mail.subject).toBe(
      'Acme <b>Loans</b>: reconnect WhatsApp number "Support & Sales" (…2345)',
    );
    expect(mail.html).not.toContain('<b>Loans');
    expect(mail.html).toContain('Support &amp; Sales');
    expect(mail.html).toContain('http://localhost:3150/whatsapp/numbers');
    expect(mail.text).toContain(
      'The WhatsApp number "Support & Sales" (…2345) needs to be connected again: Access was removed in Facebook.',
    );
  });

  it('restricted and admin disconnected', () => {
    const restricted = renderTemplate('whatsapp.restricted', {
      ...vars,
      reason: 'Policy violation',
    });
    expect(restricted.subject).toContain('is restricted');
    expect(restricted.text).toContain('Meta restricted the WhatsApp number');
    const disconnected = renderTemplate('whatsapp.admin_disconnected', {
      ...vars,
      reason: 'Spam reports',
    });
    expect(disconnected.subject).toContain('was disconnected');
    expect(disconnected.text).toContain('The number keeps working on WhatsApp');
  });
});
