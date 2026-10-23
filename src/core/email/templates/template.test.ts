import { describe, expect, it } from 'vitest';

import { renderTemplate } from '.';

const vars = {
  accountName: 'Test Co <b>',
  templateName: 'order_update',
  language: 'en',
  reason: 'the format is not valid',
  templatesUrl: 'http://localhost:3150/whatsapp/templates?id=abc',
};

describe('template e-mails', () => {
  it('rejected / disabled: subject, name, reason and link; HTML escaped', () => {
    const rejected = renderTemplate('template.rejected', vars);
    expect(rejected.subject).toBe('Your WhatsApp template was rejected');
    expect(rejected.text).toContain('"order_update" (en)');
    expect(rejected.text).toContain('the format is not valid');
    expect(rejected.html).toContain('http://localhost:3150/whatsapp/templates?id=abc');
    expect(rejected.html).not.toContain('<b>');
    const disabled = renderTemplate('template.disabled', vars);
    expect(disabled.subject).toBe('Your WhatsApp template was disabled');
    expect(disabled.text).toContain("can't be sent any more");
  });
});
