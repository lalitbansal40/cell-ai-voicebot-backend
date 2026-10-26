/**
 * Fake structured output (dev / tests / E2E — the fake provider is refused in
 * production). Deterministic rules on the customer's lines, documented in ADR 0044:
 * the first matching FAKE_RULES group decides the outcome (wrong number, refusal,
 * callback, payment claim, promise), the first number ≥ 100 is the promised amount,
 * "kal / tomorrow" is the call date + 1 day; abusive words → negative.
 */
import { FAKE_RULES } from './fake-rules';
import {
  CALL_DATE_PREFIX,
  INSIGHTS_FORMAT_NAME,
  TRANSCRIPT_CLOSE,
  TRANSCRIPT_OPEN,
} from './prompts/insights';
import type { ChatRequest } from './types';

export const CHAT_SUMMARY_FORMAT_NAME = 'chat_summary';

const addDays = (ymd: string, days: number): string => {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const between = (text: string, open: string, close: string): string => {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start + open.length, end) : '';
};

const allowedKeys = (system: string): string[] => {
  const line = system.split('\n').find((l) => l.startsWith('Allowed outcome keys: ')) ?? '';
  return [...line.matchAll(/([a-z0-9_]+) \(/g)].map((m) => m[1] ?? '');
};

const fakeInsights = (request: ChatRequest): string => {
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = request.messages.findLast((m) => m.role === 'user')?.content ?? '';
  const callDate =
    user
      .split('\n')
      .find((l) => l.startsWith(CALL_DATE_PREFIX))
      ?.slice(CALL_DATE_PREFIX.length) ?? '2026-01-01';
  const lines = between(user, TRANSCRIPT_OPEN, TRANSCRIPT_CLOSE)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const customer = lines
    .filter((l) => l.startsWith('[customer]'))
    .map((l) => l.slice('[customer]'.length).trim());
  const said = customer.join(' ');
  const rules: [RegExp, string][] = [
    [FAKE_RULES.wrongNumber, 'wrong_number'],
    [FAKE_RULES.refuse, 'not_interested'],
    [FAKE_RULES.callback, 'callback'],
    [FAKE_RULES.paymentClaim, 'paid'],
    [FAKE_RULES.promise, 'promise_to_pay'],
  ];
  const outcome = rules.find(([re]) => re.test(said))?.[1] ?? 'other';
  const keys = allowedKeys(system);
  const promise = outcome === 'promise_to_pay';
  const amount = /\b(\d{3,7})\b/.exec(said)?.[1];
  const negative = FAKE_RULES.abusive.test(said) || outcome === 'not_interested';
  const positive = promise || outcome === 'paid';
  const label = negative ? 'negative' : positive ? 'positive' : 'neutral';
  return JSON.stringify({
    summary: `Customer said: "${(customer[0] ?? '').slice(0, 120)}". Outcome: ${outcome.replace(/_/g, ' ')}.`,
    suggestedDisposition: keys.includes(outcome) ? outcome : null,
    sentiment: { label, score: negative ? -0.6 : positive ? 0.5 : 0 },
    keyInfo: {
      promiseDate: promise ? addDays(callDate, 1) : null,
      promiseAmountRupees: promise && amount ? Number(amount) : null,
      callbackAt: outcome === 'callback' ? `${addDays(callDate, 1)}T10:00:00.000Z` : null,
      disputeReason: null,
      wrongNumber: outcome === 'wrong_number',
      languagePreference: FAKE_RULES.hinglishMarkers.test(said) ? 'Hinglish' : null,
      notes: null,
    },
    confidence: { disposition: 0.9, promise: promise ? 0.8 : 0.5, sentiment: 0.7 },
  });
};

const fakeChatSummary = (request: ChatRequest): string => {
  const user = request.messages.findLast((m) => m.role === 'user')?.content ?? '';
  const lines = between(user, TRANSCRIPT_OPEN, TRANSCRIPT_CLOSE)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines
    .find((l) => l.startsWith('[customer]'))
    ?.slice('[customer]'.length)
    .trim();
  return JSON.stringify({
    summary: `${String(lines.length)} messages. Customer: "${(first ?? '').slice(0, 120)}".`,
  });
};

/** Content of a structured fake answer (`null` → the name is unknown to the fake). */
export const fakeStructured = (request: ChatRequest): string | null => {
  switch (request.responseFormat?.name) {
    case INSIGHTS_FORMAT_NAME:
      return fakeInsights(request);
    case CHAT_SUMMARY_FORMAT_NAME:
      return fakeChatSummary(request);
    default:
      return null;
  }
};
