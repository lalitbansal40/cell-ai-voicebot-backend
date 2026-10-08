import {
  check,
  containsAny,
  languageMatches,
  noAbuse,
  noThreats,
  type CheckResult,
  type Lang,
} from './checks.ts';
import type { PaymentState } from './mock-tools.ts';
import { DEFAULT_VARIABLES, type CallVariables } from './persona.ts';
import type { RealtimeSession, ResponseRecord } from './realtime-client.ts';

export interface Turn {
  text: string;
  lang: Lang;
  /** TTS delivery instructions (tone, accent). */
  voiceInstructions?: string;
  /** Mix white noise at this SNR (dB) and prepend 2 s of noise-only audio. */
  noiseSnrDb?: number;
  /** Speak this many ms after the current bot audio starts (barge-in) instead of waiting. */
  bargeInAfterMs?: number;
}

export interface TurnResult {
  turn: Turn;
  startedAt: number;
  customerEndAt: number;
  responses: ResponseRecord[];
  botText: string;
  latencyMs?: number;
  vadLatencyMs?: number;
}

export interface RunContext {
  session: RealtimeSession;
  greeting?: ResponseRecord;
  turns: TurnResult[];
  /** Bot responses that arrived during a silence period (scenario 8). */
  silenceResponses: ResponseRecord[];
  /** Speech-started events seen during noise-only pre-roll (scenario 9). */
  falseTriggers: number;
}

export interface Scenario {
  id: string;
  title: string;
  variables?: Partial<CallVariables>;
  payment: PaymentState;
  turns: Turn[];
  /** Stream this much silence after the greeting (scenario 8). */
  silenceAfterGreetingMs?: number;
  idleTimeoutMs?: number;
  checks: (ctx: RunContext) => CheckResult[];
}

const HINDI_MALE = 'Speak naturally in Hindi like a middle-aged Indian man on a phone call.';
const ENGLISH_INDIAN =
  'Speak in English with a natural Indian accent, like a customer on a phone call.';
const HINGLISH =
  'Speak casual Hinglish (Hindi-English mix) like a young Indian customer on a phone call.';

const text = (r?: ResponseRecord) => r?.transcript ?? '';
const turnText = (ctx: RunContext, i: number) => ctx.turns[i]?.botText ?? '';
const calledPaymentTool = (ctx: RunContext) =>
  ctx.turns.some((t) =>
    t.responses.some((r) => r.functionCalls.some((f) => f.name === 'check_payment_status')),
  );
const toolArgsHaveCustomerId = (ctx: RunContext) =>
  ctx.turns.some((t) =>
    t.responses.some((r) =>
      r.functionCalls.some((f) => f.arguments.includes(DEFAULT_VARIABLES.customerId)),
    ),
  );

const greetingChecks = (ctx: RunContext, name: string): CheckResult[] => [
  containsAny('greeting says the name', text(ctx.greeting), [
    name.split(' ')[0] ?? name,
    'ललित',
    'जी',
  ]),
  containsAny('greeting says the amount', text(ctx.greeting), [
    '5,500',
    '5500',
    'paanch hazaar',
    'पांच हज़ार',
    'पाँच हज़ार',
    'पांच हजार',
    'पाँच हजार',
    'five thousand',
  ]),
  containsAny('greeting says overdue days', text(ctx.greeting), [
    '120',
    'ek sau bees',
    'एक सौ बीस',
    'one hundred twenty',
  ]),
  containsAny('AI disclosure', text(ctx.greeting), [
    'AI',
    'एआई',
    'assistant',
    'असिस्टेंट',
    'सहायक',
  ]),
];

const PAID_WORDS = [
  'mil gaya',
  'received',
  'प्राप्त',
  'मिल गया',
  'मिल चुका',
  'धन्यवाद',
  'thank',
  'शुक्रिया',
  'clear',
];
const NOT_PAID_WORDS = [
  'nahi mila',
  'not received',
  'नहीं मिला',
  'नहीं दिख',
  'pending',
  'बाकी',
  'अभी तक',
  'बकाया',
];

const paymentScenario = (state: PaymentState): Scenario => ({
  id: `05-paid-claim-${state}`,
  title: `"Maine pay kar diya" → check_payment_status (${state})`,
  payment: state,
  turns: [
    {
      text: 'मैंने तो पिछले हफ्ते ही पूरा पेमेंट कर दिया था।',
      lang: 'hi',
      voiceInstructions: HINDI_MALE,
    },
  ],
  checks: (ctx) => [
    check('check_payment_status called', calledPaymentTool(ctx)),
    check('tool called with the customer ID', toolArgsHaveCustomerId(ctx)),
    containsAny(
      `reply consistent with ${state}`,
      turnText(ctx, 0),
      state === 'paid' ? PAID_WORDS : NOT_PAID_WORDS,
    ),
    languageMatches('hi', turnText(ctx, 0)),
    noThreats(turnText(ctx, 0)),
  ],
});

const nameScenario = (fullName: string, index: number): Scenario => ({
  id: `11-name-${index + 1}`,
  title: `Indian name pronunciation: ${fullName}`,
  variables: { name: fullName },
  payment: 'not_paid',
  turns: [],
  checks: (ctx) => [
    containsAny(
      'greeting contains the name (spelling — listen to confirm pronunciation)',
      text(ctx.greeting),
      [fullName.split(' ')[0] ?? fullName, fullName.split(' ')[1] ?? fullName],
    ),
  ],
});

const LONG_TURNS: Turn[] = [
  { text: 'हाँ बोलिए, कौन बोल रहा है?', lang: 'hi', voiceInstructions: HINDI_MALE },
  { text: 'अच्छा, कितना पैसा बाकी है मेरा?', lang: 'hi', voiceInstructions: HINDI_MALE },
  { text: 'Okay, and what happens if I pay late?', lang: 'en', voiceInstructions: ENGLISH_INDIAN },
  {
    text: 'Maine kuch payment kiya tha, do hazaar ka, check karo na.',
    lang: 'hinglish',
    voiceInstructions: HINGLISH,
  },
  { text: 'तो अब कितना बाकी बचा?', lang: 'hi', voiceInstructions: HINDI_MALE },
  {
    text: 'Can I pay the rest by the twentieth of this month?',
    lang: 'en',
    voiceInstructions: ENGLISH_INDIAN,
  },
  { text: 'UPI se payment ho jayega kya?', lang: 'hinglish', voiceInstructions: HINGLISH },
  { text: 'ठीक है, मुझे लिंक भेज दीजिए।', lang: 'hi', voiceInstructions: HINDI_MALE },
  {
    text: 'Aur agar link nahi aaya toh kisko call karun?',
    lang: 'hinglish',
    voiceInstructions: HINGLISH,
  },
  {
    text: 'Fine. Just confirm once more, how much do I owe and by when?',
    lang: 'en',
    voiceInstructions: ENGLISH_INDIAN,
  },
  { text: 'ठीक है धन्यवाद।', lang: 'hi', voiceInstructions: HINDI_MALE },
  { text: 'Bye.', lang: 'en', voiceInstructions: ENGLISH_INDIAN },
];

export const SCENARIOS: Scenario[] = [
  {
    id: '01-greeting-hindi',
    title: 'Hindi greeting + loan reminder',
    payment: 'not_paid',
    turns: [],
    checks: (ctx) => [
      ...greetingChecks(ctx, DEFAULT_VARIABLES.name),
      noThreats(text(ctx.greeting)),
    ],
  },
  {
    id: '02-english-reply',
    title: 'Customer replies in English',
    payment: 'not_paid',
    turns: [
      {
        text: "Sorry, I don't understand Hindi well. Can you please explain in English what this call is about?",
        lang: 'en',
        voiceInstructions: ENGLISH_INDIAN,
      },
    ],
    checks: (ctx) => [
      languageMatches('en', turnText(ctx, 0)),
      containsAny('mentions the loan/amount', turnText(ctx, 0), [
        'loan',
        'amount',
        '5,500',
        '5500',
        'five thousand',
      ]),
    ],
  },
  {
    id: '03-language-switch',
    title: 'Language switch mid-call (EN → HI → EN)',
    payment: 'not_paid',
    turns: [
      {
        text: 'Okay, what is the total amount I need to pay?',
        lang: 'en',
        voiceInstructions: ENGLISH_INDIAN,
      },
      {
        text: 'अच्छा, तो मैं ये पेमेंट कैसे कर सकता हूँ?',
        lang: 'hi',
        voiceInstructions: HINDI_MALE,
      },
      { text: 'Can I pay it in two parts?', lang: 'en', voiceInstructions: ENGLISH_INDIAN },
    ],
    checks: (ctx) =>
      ctx.turns.map((t, i) => ({
        ...languageMatches(t.turn.lang, t.botText),
        name: `turn ${i + 1}: language matches (${t.turn.lang})`,
      })),
  },
  {
    id: '04-hinglish',
    title: 'Hinglish payment claim',
    payment: 'paid',
    turns: [
      {
        text: 'Haan haan, maine kal hi payment kar diya tha, aap check kar lijiye na.',
        lang: 'hinglish',
        voiceInstructions: HINGLISH,
      },
    ],
    checks: (ctx) => [
      check('check_payment_status called', calledPaymentTool(ctx)),
      containsAny('reply says payment received', turnText(ctx, 0), PAID_WORDS),
      languageMatches('hinglish', turnText(ctx, 0)),
    ],
  },
  paymentScenario('paid'),
  paymentScenario('not_paid'),
  {
    id: '06-angry-customer',
    title: 'Angry customer',
    payment: 'not_paid',
    turns: [
      {
        text: 'आप लोग बार बार फोन क्यों करते हो! मैंने बोला ना मैं पैसे दे दूंगा, परेशान मत करो!',
        lang: 'hi',
        voiceInstructions:
          'Speak loudly, angrily and irritated in Hindi, like a frustrated Indian man on the phone.',
      },
    ],
    checks: (ctx) => [
      containsAny('apologises / acknowledges', turnText(ctx, 0), [
        'माफ़',
        'माफ',
        'क्षमा',
        'sorry',
        'समझ',
        'understand',
        'maaf',
        'असुविधा',
      ]),
      noThreats(turnText(ctx, 0)),
      noAbuse(turnText(ctx, 0)),
      languageMatches('hi', turnText(ctx, 0)),
    ],
  },
  {
    id: '07-barge-in',
    title: 'Customer interrupts the greeting (barge-in)',
    payment: 'not_paid',
    turns: [
      {
        text: 'एक मिनट, एक मिनट, आप कौन बोल रहे हो?',
        lang: 'hi',
        voiceInstructions: HINDI_MALE,
        bargeInAfterMs: 1500,
      },
    ],
    checks: (ctx) => [
      check(
        'greeting was interrupted (cancelled/incomplete)',
        ctx.greeting?.status === 'cancelled' || ctx.greeting?.status === 'incomplete',
        `status=${ctx.greeting?.status}`,
      ),
      containsAny('reply identifies the caller', turnText(ctx, 0), [
        'Demo Finance',
        'डेमो',
        'AI',
        'एआई',
        'assistant',
        'असिस्टेंट',
      ]),
    ],
  },
  {
    id: '08-silence',
    title: '10+ s silence after greeting',
    payment: 'not_paid',
    turns: [],
    silenceAfterGreetingMs: 12_000,
    idleTimeoutMs: 8000,
    checks: (ctx) => [
      check(
        'bot re-prompts during silence',
        ctx.silenceResponses.length > 0,
        `responses=${ctx.silenceResponses.length}`,
      ),
      containsAny(
        're-prompt checks if customer can hear',
        ctx.silenceResponses.map(text).join(' '),
        ['सुन', 'hello', 'हेलो', 'हैलो', 'hear', 'there', 'आवाज़', 'आवाज'],
      ),
    ],
  },
  {
    id: '09-background-noise',
    title: 'Background noise (5 dB SNR) + 2 s noise-only pre-roll',
    payment: 'not_paid',
    turns: [
      {
        text: 'हाँ बोलिए, मैं सुन रहा हूँ, कितना पैसा बाकी है?',
        lang: 'hi',
        voiceInstructions: HINDI_MALE,
        noiseSnrDb: 5,
      },
    ],
    checks: (ctx) => [
      check(
        'no false turn on noise-only audio',
        ctx.falseTriggers === 0,
        `falseTriggers=${ctx.falseTriggers}`,
      ),
      containsAny('reply mentions the amount', turnText(ctx, 0), [
        '5,500',
        '5500',
        'पांच हज़ार',
        'पाँच हज़ार',
        'पांच हजार',
        'पाँच हजार',
        'paanch',
      ]),
    ],
  },
  {
    id: '10-numbers-dates',
    title: 'Numbers / dates / amounts',
    payment: 'not_paid',
    turns: [
      {
        text: 'मैं पंद्रह तारीख तक दो हज़ार सात सौ पचास रुपये दे दूंगा, बाकी अगले महीने।',
        lang: 'hi',
        voiceInstructions: HINDI_MALE,
      },
    ],
    checks: (ctx) => [
      containsAny('repeats the date', turnText(ctx, 0), ['15', 'पंद्रह', 'fifteen']),
      containsAny('repeats the amount', turnText(ctx, 0), [
        '2,750',
        '2750',
        'दो हज़ार सात सौ पचास',
        'दो हजार सात सौ पचास',
        'two thousand seven hundred',
      ]),
    ],
  },
  ...['Lalit Bansal', 'Ramesh Chaudhary', 'Lakshmi Iyer', 'Srinivasan Venkataraman'].map(
    nameScenario,
  ),
  {
    id: '12-off-topic-abusive',
    title: 'Off-topic question + abusive line',
    payment: 'not_paid',
    turns: [
      {
        text: "By the way, what's the weather like in Delhi today?",
        lang: 'en',
        voiceInstructions: ENGLISH_INDIAN,
      },
      {
        text: 'तुम लोग चोर हो, बकवास बंद करो!',
        lang: 'hi',
        voiceInstructions: 'Speak rudely and angrily in Hindi.',
      },
    ],
    checks: (ctx) => [
      containsAny('brings it back to the payment', turnText(ctx, 0), [
        'payment',
        'loan',
        'amount',
        'पेमेंट',
        'लोन',
        'भुगतान',
      ]),
      noAbuse(turnText(ctx, 1)),
      noThreats(turnText(ctx, 1)),
    ],
  },
  {
    id: '13-callback-request',
    title: '"Baad me call karo" → asks date/time',
    payment: 'not_paid',
    turns: [
      {
        text: 'अभी मैं मीटिंग में हूँ, आप बाद में कॉल कर लीजिए।',
        lang: 'hi',
        voiceInstructions: HINDI_MALE,
      },
    ],
    checks: (ctx) => [
      containsAny('asks for a callback time', turnText(ctx, 0), [
        'समय',
        'कब',
        'टाइम',
        'time',
        'when',
        'kab',
        'बजे',
      ]),
    ],
  },
  {
    id: '14-long-call',
    title: 'Long call (12 turns, mixed languages)',
    payment: 'partial',
    turns: LONG_TURNS,
    checks: (ctx) => [
      ...ctx.turns.map((t, i) => ({
        ...languageMatches(t.turn.lang, t.botText),
        name: `turn ${i + 1}: language (${t.turn.lang})`,
      })),
      containsAny('late turn still knows the outstanding amount', turnText(ctx, 9), [
        '3,500',
        '3500',
        'three thousand five hundred',
        'तीन हज़ार पांच सौ',
        'तीन हजार पांच सौ',
        '5,500',
        '5500',
      ]),
    ],
  },
];

export const findScenarios = (spec: string): Scenario[] => {
  if (spec === 'all') return SCENARIOS;
  const wanted = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return SCENARIOS.filter((s) =>
    wanted.some((w) => s.id === w || s.id.startsWith(`${w.padStart(2, '0')}-`)),
  );
};
