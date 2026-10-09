import type { AiAgentDoc } from '../../db/models/ai-agent.model';

/** Why a reply was blocked (stored on the turn — never the text). */
export type GuardrailRule = 'never_say' | 'secret_request' | 'long_number' | 'threat';

export interface GuardrailContext {
  agent: Pick<AiAgentDoc, 'persona' | 'guardrails'>;
  /** Customer data the model was given (numbers in it may be repeated). */
  customerData: string;
}

const SECRET_TERMS =
  /\b(otp|one[- ]time password|pin|cvv|password|passcode|card number|card no|aadhaa?r number|aadhaa?r no)\b/i;
const ASKING =
  /\b(batao|bataiye|bataye|bata do|boliye|bolo|bhejo|bhejiye|dijiye|de do|share|tell|give|send|provide|enter|type|read out|say|confirm|need|want)\b/i;
const NEGATION = /\b(never|not|don't|dont|do not|no one|nobody|mat|na|nahi|nahin|kabhi)\b/i;
const THREATS = /\b(police|jail|legal action)\b/i;
const LONG_NUMBER = /\d[\d -]{10,}\d/g;

const sentences = (text: string): string[] => text.split(/(?<=[.?!।])\s+|\n+/).filter(Boolean);

/**
 * Checks a model reply before anyone sees it (PHASE_5_PROMPT §1 Guardrail
 * output check). Returns the first rule it breaks, or `null`.
 */
export const checkReply = (text: string, ctx: GuardrailContext): GuardrailRule | null => {
  const lower = text.toLowerCase();
  if (
    ctx.agent.guardrails.neverSay.some((p) => p.trim() && lower.includes(p.trim().toLowerCase()))
  ) {
    return 'never_say';
  }
  // asking for a secret (telling the customer NOT to share one is fine)
  if (sentences(text).some((s) => SECRET_TERMS.test(s) && ASKING.test(s) && !NEGATION.test(s))) {
    return 'secret_request';
  }
  const known = ctx.customerData.replace(/\D/g, '');
  for (const match of text.match(LONG_NUMBER) ?? []) {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 12 && digits.length <= 19 && !known.includes(digits)) return 'long_number';
  }
  if (ctx.agent.guardrails.complianceMode === 'recovery') {
    const persona = ctx.agent.persona.toLowerCase();
    const threat = THREATS.exec(text)?.[1]?.toLowerCase();
    if (threat && !persona.includes(threat)) return 'threat';
  }
  return null;
};

/** The system note for the one retry after a blocked reply. */
export const retryNote = (rule: GuardrailRule): string =>
  `Your last reply broke a rule: ${
    {
      never_say: 'it used a phrase you must never say',
      secret_request: 'it asked for an OTP, PIN, CVV, password, card or Aadhaar number',
      long_number: 'it contained a long number that is not in the customer data',
      threat: 'it mentioned police, jail or legal action',
    }[rule]
  }. Reply again without it.`;
