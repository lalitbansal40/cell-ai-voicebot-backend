import type { ScenarioKey } from '../../db/models/campaign.model';

/**
 * Simulated customer scripts (PHASE_8_PROMPT §1 "Simulated customer"): one
 * step per "the bot finished speaking" moment. `dtmf` may hold several keys
 * (sent one by one), `wait` does nothing (the flow's silence timer runs).
 */
export type CustomerStep = { dtmf: string } | { say: string } | { wait: true } | { hangup: true };

const d = (keys: string): CustomerStep => ({ dtmf: keys });
const s = (text: string): CustomerStep => ({ say: text });
const WAIT: CustomerStep = { wait: true };
const HANGUP: CustomerStep = { hangup: true };

export const PHRASES = {
  paid: 'haan ji payment kar diya',
  promise: 'kal tak de dunga',
  ok: 'theek hai',
  refuse: 'main payment nahi karunga',
  callback: 'abhi busy hoon, kal shaam 5 baje call karna',
  wrongNumber: 'galat number hai, main yeh vyakti nahi hoon',
  badService: 'service achhi nahi thi',
} as const;

type Script = Record<ScenarioKey, CustomerStep[]>;

/** Scripts written for the four flow templates (`Flow.templateKey`). */
export const TEMPLATE_SCRIPTS: Record<string, Script> = {
  loan_recovery: {
    paid: [d('1'), s(PHRASES.paid)],
    promise: [d('1'), s(PHRASES.promise), s(PHRASES.ok)],
    refuse: [d('3'), s(PHRASES.refuse), HANGUP],
    callback: [d('3'), s(PHRASES.callback)],
    silence: [WAIT, WAIT, WAIT],
    wrong_number: [d('3'), s(PHRASES.wrongNumber), HANGUP],
    hangup_early: [HANGUP],
    wrong_keys: [d('9'), d('9'), d('9')],
  },
  payment_reminder: {
    paid: [d('1')],
    promise: [d('2'), d('3#')],
    refuse: [d('2'), s(PHRASES.refuse), HANGUP],
    callback: [d('2'), s(PHRASES.callback), HANGUP],
    silence: [WAIT, WAIT, WAIT],
    wrong_number: [s(PHRASES.wrongNumber), HANGUP],
    hangup_early: [HANGUP],
    wrong_keys: [d('9'), d('9'), d('9')],
  },
  feedback_survey: {
    paid: [d('5')],
    promise: [d('4')],
    refuse: [d('1'), s(PHRASES.badService)],
    callback: [d('3')],
    silence: [WAIT, WAIT, WAIT],
    wrong_number: [s(PHRASES.wrongNumber), HANGUP],
    hangup_early: [HANGUP],
    wrong_keys: [d('9'), d('9'), d('9')],
  },
};

/** A fixed 10-phrase Hinglish bank for flows without a script. */
export const GENERIC_PHRASES = [
  'haan ji bataiye',
  'kitna baaki hai',
  'payment kar diya hai',
  'kal tak de dunga',
  'abhi busy hoon',
  'theek hai',
  'nahi chahiye',
  'kaun bol raha hai',
  'baad mein baat karte hain',
  'dhanyavaad',
] as const;

/** Generic steps for any other flow (or an agent alone): up to 8, then hang up. */
export const genericScript = (rng: () => number): CustomerStep[] => {
  const steps: CustomerStep[] = [];
  for (let i = 0; i < 7; i += 1) {
    const roll = rng();
    if (roll < 0.4) steps.push(d(String(1 + Math.floor(rng() * 3))));
    else if (roll < 0.85) {
      const at = Math.floor(rng() * GENERIC_PHRASES.length);
      steps.push(...GENERIC_PHRASES.slice(at, at + 1).map(s));
    } else steps.push(WAIT);
  }
  steps.push(HANGUP);
  return steps;
};

/** The script for a template key and scenario; unknown templates get the generic one. */
export const scriptFor = (
  templateKey: string | null,
  scenario: ScenarioKey,
  rng: () => number,
): CustomerStep[] => {
  const script = templateKey ? TEMPLATE_SCRIPTS[templateKey] : undefined;
  return script ? script[scenario] : genericScript(rng);
};

/** Picks a scenario by weight (0–100 each); all zero → `silence`. */
export const pickScenario = (
  weights: Record<ScenarioKey, number>,
  rng: () => number,
): ScenarioKey => {
  const entries = Object.entries(weights) as [ScenarioKey, number][];
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0);
  if (total <= 0) return 'silence';
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    roll -= Math.max(0, weight);
    if (roll < 0) return key;
  }
  return 'silence'; // float rounding only
};
