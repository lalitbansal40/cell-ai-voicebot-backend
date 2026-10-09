import { describe, expect, it } from 'vitest';

import { agentTemplates, findTemplate, paymentCheckUrl, TEMPLATE_KEYS } from './templates';

const ON = { APP_URL: 'http://localhost:4000/', MOCK_APIS_ENABLED: true };
const OFF = { APP_URL: 'https://app.example.in', MOCK_APIS_ENABLED: false };

describe('agent templates', () => {
  it('has one template per key, all with {{company}} and {{name}} only', () => {
    expect(agentTemplates(ON).map((t) => t.key)).toEqual([...TEMPLATE_KEYS]);
    for (const t of agentTemplates(ON)) {
      expect(t.values.allowedVariables).toEqual(['name']);
      const texts = [t.values.persona, t.values.openingLine, t.values.closingLine].join(' ');
      for (const [, name] of texts.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        expect(['company', 'name']).toContain(name);
      }
    }
  });

  it('points the payment check at the mock API only when mocks are on', () => {
    expect(paymentCheckUrl(ON)).toBe(
      'http://localhost:4000/api/v1/mock/payment-status?phone={{contact.phone}}',
    );
    expect(paymentCheckUrl(OFF)).toBe('https://example.com/payment-status?phone={{contact.phone}}');
    expect(findTemplate(OFF, 'payment_reminder')?.values.functions[0]?.url).toContain(
      'example.com',
    );
    expect(findTemplate(ON, 'nope')).toBeUndefined();
  });
});
