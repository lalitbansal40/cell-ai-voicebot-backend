import { describe, expect, it } from 'vitest';

import { checkReply, retryNote } from './guardrails';

const ctx = (
  over: {
    neverSay?: string[];
    complianceMode?: 'recovery' | 'general';
    persona?: string;
    data?: string;
  } = {},
) => ({
  agent: {
    persona: over.persona ?? 'Aap recovery assistant hain.',
    guardrails: {
      neverSay: over.neverSay ?? ['legal notice'],
      disclosureLine: '',
      complianceMode: over.complianceMode ?? 'recovery',
    },
  },
  customerData: over.data ?? 'name: Asha Verma loan: 123456789012',
});

describe('checkReply', () => {
  it.each([
    ['Hum aapko Legal Notice bhejenge.', 'never_say'],
    ['Kripya apna OTP batao.', 'secret_request'],
    ['Please tell me your card number.', 'secret_request'],
    ['Apna Aadhaar number share kijiye', 'secret_request'],
    ['Your account 9876543210123456 is overdue.', 'long_number'],
    ['Police aapke ghar aayegi.', 'threat'],
    ['We may take legal action.', 'threat'],
  ])('%s → %s', (text, rule) => {
    expect(checkReply(text, ctx())).toBe(rule);
  });

  it.each([
    'Kabhi bhi apna OTP kisi ko mat batao.',
    'Never share your PIN or password with anyone.',
    'Aapka loan 123456789012 hai.',
    'Call 9876543210 for help.',
    'Ji, main samajh raha hoon.',
  ])('allows "%s"', (text) => {
    expect(checkReply(text, ctx())).toBeNull();
  });

  it('threat words are allowed outside recovery mode or when the persona has them', () => {
    expect(
      checkReply('Police complaint ka process yeh hai.', ctx({ complianceMode: 'general' })),
    ).toBeNull();
    expect(
      checkReply(
        'This may lead to legal action.',
        ctx({ persona: 'Mention legal action factually.' }),
      ),
    ).toBeNull();
  });

  it('builds a retry note per rule', () => {
    expect(retryNote('secret_request')).toBe(
      'Your last reply broke a rule: it asked for an OTP, PIN, CVV, password, card or Aadhaar number. Reply again without it.',
    );
  });
});
