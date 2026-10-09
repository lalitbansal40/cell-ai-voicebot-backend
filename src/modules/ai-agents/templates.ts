import type { Env } from '../../config/env';
import {
  DEFAULT_DISCLOSURE,
  DEFAULT_FALLBACKS,
  DISPOSITIONS,
  defaultBuiltInTools,
  type AiAgentDoc,
  type BuiltInToolsConfig,
  type FunctionParam,
} from '../../db/models/ai-agent.model';

export const TEMPLATE_KEYS = [
  'loan_recovery_hinglish',
  'payment_reminder',
  'feedback_survey',
  'inbound_support',
] as const;
export type TemplateKey = (typeof TEMPLATE_KEYS)[number];

/** Function shape a template brings (no secrets — headers empty). */
export interface TemplateFunction {
  name: string;
  description: string;
  parameters: FunctionParam[];
  method: 'GET';
  url: string;
  headers: [];
  bodyTemplate: null;
  resultPath: null;
  responseHint: string;
  timeoutMs: number;
}

export type TemplateValues = Pick<
  AiAgentDoc,
  | 'description'
  | 'persona'
  | 'openingLine'
  | 'closingLine'
  | 'allowedVariables'
  | 'voice'
  | 'languageMode'
  | 'language'
  | 'toneRules'
  | 'guardrails'
  | 'fallback'
> & { builtInTools: BuiltInToolsConfig; functions: TemplateFunction[] };

export interface AgentTemplate {
  key: TemplateKey;
  title: string;
  summary: string;
  language: string;
  values: TemplateValues;
}

/** URL of the built-in mock payment API, or a placeholder the client must replace. */
export const paymentCheckUrl = (env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'>): string =>
  env.MOCK_APIS_ENABLED
    ? `${env.APP_URL.replace(/\/+$/, '')}/api/v1/mock/payment-status?phone={{contact.phone}}`
    : 'https://example.com/payment-status?phone={{contact.phone}}';

const paymentCheck = (env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'>): TemplateFunction => ({
  name: 'check_payment_status',
  description:
    "Check in the company's records whether the customer has paid. Call it when the customer says they have paid or asks about their dues.",
  parameters: [],
  method: 'GET',
  url: paymentCheckUrl(env),
  headers: [],
  bodyTemplate: null,
  resultPath: null,
  responseHint:
    'The result has status (paid / unpaid / partial), amountRupees and paidOn. Tell the customer what the record says.',
  timeoutMs: 6000,
});

const tools = (patch: Partial<BuiltInToolsConfig>): BuiltInToolsConfig => ({
  ...defaultBuiltInTools(),
  ...patch,
});

const CALM = [
  {
    when: 'angry' as const,
    respond:
      'Main aapki pareshani samajh sakta hoon. Aaram se baat karte hain, main poori madad karunga.',
  },
  {
    when: 'confused' as const,
    respond: 'Koi baat nahi, main aasaan shabdon mein dobara samjhata hoon.',
  },
  {
    when: 'abusive' as const,
    respond: 'Kripya shant rahiye. Main aapki madad ke liye hi call kar raha hoon.',
  },
];

export const agentTemplates = (
  env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'>,
): AgentTemplate[] => [
  {
    key: 'loan_recovery_hinglish',
    title: 'Loan recovery (Hinglish)',
    summary:
      'Reminds a borrower of an overdue EMI, checks payment claims and records promises to pay.',
    language: 'Hinglish',
    values: {
      description: 'Overdue EMI follow-up with payment check and promise to pay.',
      persona:
        'Aap {{company}} ki taraf se ek vinamra recovery assistant hain. Aapka kaam customer ko unki overdue EMI ki yaad dilana hai. Customer ka naam {{name}} hai. Pehle pehchaan confirm kijiye, phir due amount ke baare mein batayiye aur poochhiye ki payment kab tak ho paayega. Agar customer kahe ki payment ho gaya hai to check_payment_status se record check kijiye. Agar payment nahi hua hai to ek tareekh ka promise lijiye aur save_promise_to_pay se note kijiye. Kabhi dhamki mat dijiye.',
      openingLine:
        'Namaste {{name}} ji, main {{company}} se bol raha hoon. Kya aapse do minute baat ho sakti hai?',
      closingLine: 'Aapke samay ke liye dhanyavaad. Aapka din shubh ho.',
      allowedVariables: ['name'],
      voice: 'coral',
      languageMode: 'auto',
      language: 'hinglish',
      toneRules: CALM,
      guardrails: {
        neverSay: ['legal notice', 'police'],
        disclosureLine: DEFAULT_DISCLOSURE,
        complianceMode: 'recovery',
      },
      fallback: { ...DEFAULT_FALLBACKS },
      builtInTools: tools({
        savePromiseToPay: { enabled: true, maxDaysAhead: 15 },
        scheduleCallback: { enabled: true, maxDaysAhead: 7 },
        setDisposition: { enabled: true, allowed: [...DISPOSITIONS] },
      }),
      functions: [paymentCheck(env)],
    },
  },
  {
    key: 'payment_reminder',
    title: 'Payment reminder',
    summary: 'A short, friendly reminder before the due date with a payment check.',
    language: 'Hinglish',
    values: {
      description: 'Friendly reminder before the due date.',
      persona:
        'Aap {{company}} ki taraf se ek friendly reminder assistant hain. Customer {{name}} ko unki aane wali payment ki yaad dilaiye. Agar customer kahe ki payment ho chuka hai to check_payment_status se check kijiye. Baat chhoti aur vinamra rakhiye.',
      openingLine: 'Namaste {{name}} ji, {{company}} ki taraf se ek chhota sa reminder hai.',
      closingLine: 'Dhanyavaad, aapka din achha rahe.',
      allowedVariables: ['name'],
      voice: 'shimmer',
      languageMode: 'auto',
      language: 'hinglish',
      toneRules: CALM.slice(0, 2),
      guardrails: { neverSay: [], disclosureLine: DEFAULT_DISCLOSURE, complianceMode: 'recovery' },
      fallback: { ...DEFAULT_FALLBACKS },
      builtInTools: tools({
        setDisposition: { enabled: true, allowed: ['paid', 'promise_to_pay', 'other'] },
      }),
      functions: [paymentCheck(env)],
    },
  },
  {
    key: 'feedback_survey',
    title: 'Feedback survey',
    summary: 'Asks two or three short questions about the service and thanks the customer.',
    language: 'Hinglish',
    values: {
      description: 'Short customer feedback call.',
      persona:
        'Aap {{company}} ki taraf se feedback le rahe hain. Customer {{name}} se poochhiye ki unhe service kaisi lagi (1 se 5), kya achha laga aur kya behtar ho sakta hai. Jawab sunkar dhanyavaad dijiye. Koi bechne ki koshish mat kijiye.',
      openingLine:
        'Namaste {{name}} ji, {{company}} aapki raay jaanna chahta hai. Kya aap do minute de sakte hain?',
      closingLine: 'Aapki raay ke liye bahut dhanyavaad.',
      allowedVariables: ['name'],
      voice: 'sage',
      languageMode: 'auto',
      language: 'hinglish',
      toneRules: CALM.slice(1, 2),
      guardrails: { neverSay: [], disclosureLine: DEFAULT_DISCLOSURE, complianceMode: 'general' },
      fallback: { ...DEFAULT_FALLBACKS },
      builtInTools: tools({
        setDisposition: { enabled: true, allowed: ['not_interested', 'other'] },
      }),
      functions: [],
    },
  },
  {
    key: 'inbound_support',
    title: 'Inbound support',
    summary: 'Answers questions from the knowledge base and hands over to a person when needed.',
    language: 'Auto',
    values: {
      description: 'Answers customer questions from the knowledge base.',
      persona:
        'Aap {{company}} ke support assistant hain. Customer ke sawaalon ka jawab sirf company ki jaankari (knowledge) se dijiye. Agar jawab na pata ho to sach bataiye aur insaan se baat karwane ki peshkash kijiye.',
      openingLine:
        'Namaste, {{company}} support mein aapka swagat hai. Main aapki kya madad kar sakta hoon?',
      closingLine: 'Sampark karne ke liye dhanyavaad.',
      allowedVariables: ['name'],
      voice: 'alloy',
      languageMode: 'auto',
      language: 'hinglish',
      toneRules: CALM,
      guardrails: { neverSay: [], disclosureLine: DEFAULT_DISCLOSURE, complianceMode: 'general' },
      fallback: { ...DEFAULT_FALLBACKS },
      builtInTools: tools({
        transferToHuman: {
          enabled: true,
          phone: null,
          message: 'Main aapko hamari team se jod raha hoon.',
        },
      }),
      functions: [],
    },
  },
];

export const findTemplate = (
  env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'>,
  key: string,
): AgentTemplate | undefined => agentTemplates(env).find((t) => t.key === key);
