import type { Env } from '../../config/env';
import type { FlowVarType, NodeType } from '../../db/models/flow.model';

/** Locked Loan recovery texts (PHASE_6_PROMPT §1 Templates) — E2E asserts them. */
export const LOAN_TEXTS = {
  greet:
    'Namaste {{name}}, main {{company}} ki taraf se ek AI assistant bol rahi hoon. Aapki {{amount}} ki EMI {{due_date}} ko due thi.',
  menu: 'Agar aap payment kar chuke hain to 1 dabaiye. Payment link chahiye to 2 dabaiye. Humse baat karne ke liye 3 dabaiye.',
  paid: 'Dhanyavaad! Aapka payment hamare record mein mil gaya hai. Aapka din shubh ho.',
  notFound:
    'Abhi tak hamare record mein aapka payment nahi dikh raha. Main aapko hamare assistant se jod rahi hoon.',
  sms: '{{company}}: Aapki EMI ka payment link https://pay.example.com/{{loan_id}}',
  linkSent: 'Payment link aapke number par SMS se bhej diya gaya hai. Dhanyavaad!',
  promise: 'Aapka promise {{promise_date}} ke liye save ho gaya hai. Dhanyavaad!',
  callback: 'Koi baat nahi, hum aapko baad mein call karenge. Dhanyavaad!',
  transfer: 'Main aapko hamare team member se jod rahi hoon.',
  bye: 'Dhanyavaad, namaste.',
} as const;

/** Placeholder transfer number in templates — replace with your team's number. */
export const TEMPLATE_TRANSFER_PHONE = '+919000000000';

export interface TemplateAiNode {
  nodeId: string;
  label: string;
  /** Phase 5 agent template that fits this node (UI pre-selects / offers to create it). */
  suggestedAgentTemplate: string | null;
}

export interface FlowTemplate {
  key: string;
  title: string;
  description: string;
  language: 'hi' | 'en' | 'hinglish';
  /** Contact fields the texts use; missing ones become flow variables. */
  optionalFields: { name: string; type: FlowVarType }[];
  aiNodes: TemplateAiNode[];
  graph: (env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'>) => Record<string, unknown>;
}

type N = { id: string; type: NodeType; label: string; at: [number, number]; config?: object };
type E = [source: string, handle: string, target: string];

/** Grid (column, row) → canvas position (node ≈ 240 × 90). */
const graphOf = (
  nodes: N[],
  edges: E[],
  variables: { name: string; type: FlowVarType }[],
  extra: object = {},
) => ({
  schemaVersion: 1,
  nodes: nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.label,
    position: { x: n.at[0] * 300, y: n.at[1] * 150 },
    config: n.config ?? {},
  })),
  edges: edges.map(([source, sourceHandle, target]) => ({
    id: `e_${source}_${sourceHandle}`,
    source,
    sourceHandle,
    target,
  })),
  variables,
  settings: { language: 'hinglish', ...extra },
});

const mockUrl = (
  env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED'>,
  path: string,
  placeholder: string,
) =>
  env.MOCK_APIS_ENABLED
    ? `${env.APP_URL.replace(/\/+$/, '')}/api/v1/mock/${path}?phone={{contact.phone}}`
    : `${placeholder}?phone={{contact.phone}}`;

const speak = (text: string) => ({ text });
const prompt = (text: string) => ({ kind: 'speak', text });

const loanRecovery: FlowTemplate = {
  key: 'loan_recovery',
  title: 'Loan recovery',
  description:
    'Greets the customer with the EMI due, keypad menu: 1 = already paid (checked with your payment API), 2 = payment link by SMS, 3 = talk to the AI agent; promise, callback and transfer branches.',
  language: 'hinglish',
  optionalFields: [
    { name: 'amount', type: 'text' },
    { name: 'due_date', type: 'date' },
    { name: 'loan_id', type: 'text' },
  ],
  aiNodes: [
    { nodeId: 'ai', label: 'Recovery agent', suggestedAgentTemplate: 'loan_recovery_hinglish' },
  ],
  graph: (env) =>
    graphOf(
      [
        { id: 'start', type: 'start', label: 'Start', at: [2, 0] },
        {
          id: 'greet',
          type: 'speak',
          label: 'Greeting',
          at: [2, 1],
          config: speak(LOAN_TEXTS.greet),
        },
        {
          id: 'menu',
          type: 'gather_dtmf',
          label: 'Main menu',
          at: [2, 2],
          config: {
            prompt: prompt(LOAN_TEXTS.menu),
            keys: [
              { id: 'k1', key: '1', label: 'Already paid' },
              { id: 'k2', key: '2', label: 'Payment link' },
              { id: 'k3', key: '3', label: 'Talk to us' },
            ],
          },
        },
        {
          id: 'check',
          type: 'api_request',
          label: 'Check payment',
          at: [0, 3],
          config: {
            method: 'GET',
            url: mockUrl(env, 'payment-status', 'https://example.com/payment-status'),
            saveResponse: [{ path: 'status', variable: 'payment_status' }],
          },
        },
        {
          id: 'paid_router',
          type: 'condition_router',
          label: 'Paid?',
          at: [0, 4],
          config: {
            rules: [
              {
                id: 'paid',
                label: 'Paid',
                conditions: [{ variable: 'payment_status', operator: 'equals', value: 'paid' }],
              },
            ],
          },
        },
        {
          id: 'thanks',
          type: 'speak',
          label: 'Thanks',
          at: [0, 5],
          config: speak(LOAN_TEXTS.paid),
        },
        {
          id: 'disp_paid',
          type: 'set_disposition',
          label: 'Paid',
          at: [0, 6],
          config: { disposition: 'paid' },
        },
        {
          id: 'not_found',
          type: 'speak',
          label: 'Not in record',
          at: [1, 5],
          config: speak(LOAN_TEXTS.notFound),
        },
        {
          id: 'sms',
          type: 'send_sms',
          label: 'Payment link SMS',
          at: [2, 3],
          config: { text: LOAN_TEXTS.sms },
        },
        {
          id: 'link_sent',
          type: 'speak',
          label: 'Link sent',
          at: [2, 4],
          config: speak(LOAN_TEXTS.linkSent),
        },
        {
          id: 'disp_promise',
          type: 'set_disposition',
          label: 'Promise to pay',
          at: [2, 5],
          config: { disposition: 'promise_to_pay' },
        },
        {
          id: 'ai',
          type: 'ai_agent',
          label: 'Recovery agent',
          at: [3, 6],
          config: {
            agentId: '',
            goal: 'Collect a payment date (promise to pay) or transfer to a team member.',
          },
        },
        {
          id: 'promise_ok',
          type: 'speak',
          label: 'Promise saved',
          at: [2, 7],
          config: speak(LOAN_TEXTS.promise),
        },
        {
          id: 'callback',
          type: 'speak',
          label: 'Call later',
          at: [4, 7],
          config: speak(LOAN_TEXTS.callback),
        },
        {
          id: 'disp_callback',
          type: 'set_disposition',
          label: 'Callback requested',
          at: [4, 8],
          config: { disposition: 'callback_requested' },
        },
        {
          id: 'transfer',
          type: 'transfer_to_agent',
          label: 'Transfer',
          at: [5, 7],
          config: { phone: TEMPLATE_TRANSFER_PHONE, announcement: LOAN_TEXTS.transfer },
        },
        {
          id: 'bye',
          type: 'hangup',
          label: 'Goodbye',
          at: [2, 9],
          config: { text: LOAN_TEXTS.bye },
        },
      ],
      [
        ['start', 'next', 'greet'],
        ['greet', 'next', 'menu'],
        ['menu', 'key_k1', 'check'],
        ['menu', 'key_k2', 'sms'],
        ['menu', 'key_k3', 'ai'],
        ['menu', 'no_input', 'callback'],
        ['menu', 'invalid', 'callback'],
        ['check', 'success', 'paid_router'],
        ['check', 'failure', 'ai'],
        ['check', 'error', 'ai'],
        ['paid_router', 'rule_paid', 'thanks'],
        ['paid_router', 'else', 'not_found'],
        ['thanks', 'next', 'disp_paid'],
        ['disp_paid', 'next', 'bye'],
        ['not_found', 'next', 'ai'],
        ['sms', 'next', 'link_sent'],
        ['link_sent', 'next', 'disp_promise'],
        ['disp_promise', 'next', 'bye'],
        ['ai', 'paid', 'thanks'],
        ['ai', 'promise_to_pay', 'promise_ok'],
        ['ai', 'callback', 'callback'],
        ['ai', 'transfer', 'transfer'],
        ['ai', 'resolved', 'bye'],
        ['ai', 'no_response', 'callback'],
        ['ai', 'error', 'callback'],
        ['promise_ok', 'next', 'bye'],
        ['callback', 'next', 'disp_callback'],
        ['disp_callback', 'next', 'bye'],
        ['transfer', 'failed', 'callback'],
        ['transfer', 'no_answer', 'callback'],
      ],
      [{ name: 'payment_status', type: 'text' }],
    ),
};

const paymentReminder: FlowTemplate = {
  key: 'payment_reminder',
  title: 'Payment reminder',
  description:
    'Reminds the customer of an upcoming payment; 1 = already paid, 2 = pay later (asks in how many days on the keypad).',
  language: 'hinglish',
  optionalFields: [
    { name: 'amount', type: 'text' },
    { name: 'due_date', type: 'date' },
  ],
  aiNodes: [],
  graph: () =>
    graphOf(
      [
        { id: 'start', type: 'start', label: 'Start', at: [1, 0] },
        {
          id: 'remind',
          type: 'speak',
          label: 'Reminder',
          at: [1, 1],
          config: speak(
            'Namaste {{name}}, main {{company}} ki taraf se ek AI assistant bol rahi hoon. Yaad dila rahe hain ki aapki {{amount}} ki payment {{due_date}} ko due hai.',
          ),
        },
        {
          id: 'menu',
          type: 'gather_dtmf',
          label: 'Paid or later',
          at: [1, 2],
          config: {
            prompt: prompt('Payment ho gaya ho to 1 dabaiye. Baad mein karenge to 2 dabaiye.'),
            keys: [
              { id: 'k1', key: '1', label: 'Paid' },
              { id: 'k2', key: '2', label: 'Pay later' },
            ],
          },
        },
        {
          id: 'paid',
          type: 'speak',
          label: 'Thanks',
          at: [0, 3],
          config: speak('Dhanyavaad! Aapka din shubh ho.'),
        },
        {
          id: 'disp_paid',
          type: 'set_disposition',
          label: 'Paid',
          at: [0, 4],
          config: { disposition: 'paid' },
        },
        {
          id: 'days',
          type: 'gather_dtmf',
          label: 'In how many days',
          at: [1, 3],
          config: {
            prompt: prompt('Kitne din mein payment karenge? Number dabakar # dabaiye.'),
            mode: 'digits',
            minDigits: 1,
            maxDigits: 2,
            saveAs: 'days',
          },
        },
        {
          id: 'note',
          type: 'set_variable',
          label: 'Note',
          at: [1, 4],
          config: {
            assignments: [{ variable: 'reminder_note', op: 'set', value: '{{days}} din' }],
          },
        },
        {
          id: 'confirm',
          type: 'speak',
          label: 'Confirm',
          at: [1, 5],
          config: speak('Theek hai, {{days}} din mein payment ka intezaar rahega. Dhanyavaad!'),
        },
        {
          id: 'disp_promise',
          type: 'set_disposition',
          label: 'Promise to pay',
          at: [1, 6],
          config: { disposition: 'promise_to_pay', note: '{{reminder_note}}' },
        },
        {
          id: 'callback',
          type: 'speak',
          label: 'Call later',
          at: [2, 4],
          config: speak(LOAN_TEXTS.callback),
        },
        {
          id: 'disp_callback',
          type: 'set_disposition',
          label: 'Callback requested',
          at: [2, 5],
          config: { disposition: 'callback_requested' },
        },
        {
          id: 'bye',
          type: 'hangup',
          label: 'Goodbye',
          at: [1, 7],
          config: { text: LOAN_TEXTS.bye },
        },
      ],
      [
        ['start', 'next', 'remind'],
        ['remind', 'next', 'menu'],
        ['menu', 'key_k1', 'paid'],
        ['menu', 'key_k2', 'days'],
        ['menu', 'no_input', 'callback'],
        ['menu', 'invalid', 'callback'],
        ['paid', 'next', 'disp_paid'],
        ['disp_paid', 'next', 'bye'],
        ['days', 'next', 'note'],
        ['days', 'no_input', 'callback'],
        ['days', 'invalid', 'callback'],
        ['note', 'next', 'confirm'],
        ['confirm', 'next', 'disp_promise'],
        ['disp_promise', 'next', 'bye'],
        ['callback', 'next', 'disp_callback'],
        ['disp_callback', 'next', 'bye'],
      ],
      [
        { name: 'days', type: 'number' },
        { name: 'reminder_note', type: 'text' },
      ],
    ),
};

const feedbackSurvey: FlowTemplate = {
  key: 'feedback_survey',
  title: 'Feedback survey',
  description: 'Asks for a 1–5 rating on the keypad; low ratings are asked what went wrong.',
  language: 'hinglish',
  optionalFields: [],
  aiNodes: [],
  graph: () =>
    graphOf(
      [
        { id: 'start', type: 'start', label: 'Start', at: [1, 0] },
        {
          id: 'intro',
          type: 'speak',
          label: 'Intro',
          at: [1, 1],
          config: speak(
            'Namaste {{name}}, main {{company}} ki taraf se ek AI assistant bol rahi hoon. Hamari service ke baare mein ek chhota sa sawaal hai.',
          ),
        },
        {
          id: 'rating',
          type: 'gather_dtmf',
          label: 'Rating',
          at: [1, 2],
          config: {
            prompt: prompt('1 se 5 ke beech rating dijiye — 5 sabse achha.'),
            keys: ['1', '2', '3', '4', '5'].map((key) => ({
              id: `r${key}`,
              key,
              label: `${key} star`,
            })),
            saveAs: 'rating',
          },
        },
        {
          id: 'low',
          type: 'condition_router',
          label: 'Low rating?',
          at: [1, 3],
          config: {
            rules: [
              {
                id: 'low',
                label: 'Rating ≤ 2',
                conditions: [{ variable: 'rating', operator: 'lte', value: '2' }],
              },
            ],
          },
        },
        {
          id: 'ask',
          type: 'gather_speech',
          label: 'What went wrong',
          at: [0, 4],
          config: { prompt: prompt('Maaf kijiye. Bataiye kya problem hui?'), saveAs: 'feedback' },
        },
        {
          id: 'thanks',
          type: 'speak',
          label: 'Thanks',
          at: [1, 5],
          config: speak('Aapke feedback ke liye dhanyavaad!'),
        },
        {
          id: 'bye',
          type: 'hangup',
          label: 'Goodbye',
          at: [1, 6],
          config: { text: LOAN_TEXTS.bye },
        },
      ],
      [
        ['start', 'next', 'intro'],
        ['intro', 'next', 'rating'],
        ...['1', '2', '3', '4', '5'].map((key): E => ['rating', `key_r${key}`, 'low']),
        ['rating', 'no_input', 'bye'],
        ['rating', 'invalid', 'bye'],
        ['low', 'rule_low', 'ask'],
        ['low', 'else', 'thanks'],
        ['ask', 'next', 'thanks'],
        ['ask', 'no_input', 'thanks'],
        ['thanks', 'next', 'bye'],
      ],
      [
        { name: 'rating', type: 'number' },
        { name: 'feedback', type: 'text' },
      ],
    ),
};

const inboundSupport: FlowTemplate = {
  key: 'inbound_support',
  title: 'Inbound support',
  description:
    'Answers incoming calls: listens for balance, payment or "talk to someone" and routes to your balance API, the AI agent or a team member.',
  language: 'hinglish',
  optionalFields: [],
  aiNodes: [{ nodeId: 'ai', label: 'Support agent', suggestedAgentTemplate: 'inbound_support' }],
  graph: (env) =>
    graphOf(
      [
        {
          id: 'start',
          type: 'start',
          label: 'Start',
          at: [1, 0],
          config: { triggers: ['inbound', 'test'] },
        },
        {
          id: 'welcome',
          type: 'speak',
          label: 'Welcome',
          at: [1, 1],
          config: speak('Namaste, {{company}} mein aapka swagat hai. Main ek AI assistant hoon.'),
        },
        {
          id: 'ask',
          type: 'gather_speech',
          label: 'How can we help',
          at: [1, 2],
          config: {
            prompt: prompt(
              'Bataiye, main aapki kya madad kar sakti hoon? Balance, payment ya kisi se baat?',
            ),
            saveAs: 'request',
            intents: [
              {
                id: 'balance',
                label: 'Balance',
                keywords: ['balance', 'baaki', 'kitna', 'outstanding', 'बकाया'],
              },
              {
                id: 'payment',
                label: 'Payment',
                keywords: ['pay', 'payment', 'bhugtan', 'भुगतान'],
              },
              {
                id: 'agent',
                label: 'Talk to someone',
                keywords: ['agent', 'insaan', 'human', 'baat'],
              },
            ],
          },
        },
        {
          id: 'balance',
          type: 'api_request',
          label: 'Get balance',
          at: [0, 3],
          config: {
            method: 'GET',
            url: mockUrl(env, 'loan-balance', 'https://example.com/loan-balance'),
            saveResponse: [
              { path: 'outstandingRupees', variable: 'outstanding' },
              { path: 'dueDate', variable: 'balance_due' },
            ],
          },
        },
        {
          id: 'say_balance',
          type: 'speak',
          label: 'Tell balance',
          at: [0, 4],
          config: speak('Aapka baaki amount ₹{{outstanding}} hai, due date {{balance_due}} hai.'),
        },
        {
          id: 'ai',
          type: 'ai_agent',
          label: 'Support agent',
          at: [1, 4],
          config: { agentId: '', goal: "Answer the customer's question from the knowledge base." },
        },
        {
          id: 'transfer',
          type: 'transfer_to_agent',
          label: 'Transfer',
          at: [2, 4],
          config: { phone: TEMPLATE_TRANSFER_PHONE, announcement: LOAN_TEXTS.transfer },
        },
        {
          id: 'sorry',
          type: 'speak',
          label: 'Sorry',
          at: [2, 5],
          config: speak(LOAN_TEXTS.callback),
        },
        {
          id: 'bye',
          type: 'hangup',
          label: 'Goodbye',
          at: [1, 6],
          config: { text: LOAN_TEXTS.bye },
        },
      ],
      [
        ['start', 'next', 'welcome'],
        ['welcome', 'next', 'ask'],
        ['ask', 'intent_balance', 'balance'],
        ['ask', 'intent_payment', 'ai'],
        ['ask', 'intent_agent', 'transfer'],
        ['ask', 'no_match', 'ai'],
        ['ask', 'no_input', 'bye'],
        ['balance', 'success', 'say_balance'],
        ['balance', 'failure', 'ai'],
        ['balance', 'error', 'ai'],
        ['say_balance', 'next', 'bye'],
        ['ai', 'transfer', 'transfer'],
        ['ai', 'resolved', 'bye'],
        ['ai', 'no_response', 'bye'],
        ['ai', 'error', 'sorry'],
        ['transfer', 'failed', 'sorry'],
        ['transfer', 'no_answer', 'sorry'],
        ['sorry', 'next', 'bye'],
      ],
      [
        { name: 'request', type: 'text' },
        { name: 'outstanding', type: 'number' },
        { name: 'balance_due', type: 'date' },
      ],
    ),
};

export const FLOW_TEMPLATES: readonly FlowTemplate[] = [
  loanRecovery,
  paymentReminder,
  feedbackSurvey,
  inboundSupport,
];

export const findFlowTemplate = (key: string): FlowTemplate | undefined =>
  FLOW_TEMPLATES.find((t) => t.key === key);

/** `GET /flows/templates` (no graphs). */
export const listFlowTemplates = () =>
  FLOW_TEMPLATES.map(({ key, title, description, language, aiNodes, optionalFields }) => ({
    key,
    title,
    description,
    language,
    aiNodes,
    optionalFields: optionalFields.map((f) => f.name),
  }));
