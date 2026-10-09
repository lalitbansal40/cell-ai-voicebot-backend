import { AI_LIMITS } from '../../config/limits';

import {
  KNOWLEDGE_CLOSE,
  KNOWLEDGE_OPEN,
  PERSONA_HEADING,
  TODAY_PREFIX,
  TONE_HEADING,
  TONE_LINE,
} from './markers';
import type {
  AiProvider,
  ChatMessage,
  ChatRequest,
  ChatResult,
  EmbedRequest,
  EmbedResult,
  ToolCall,
  ToolDefinition,
} from './types';

/**
 * Deterministic stand-in for OpenAI (dev / tests / E2E — refused in
 * production). Rules are checked in order; documented in ADR 0033.
 */
export const FAKE_RULES = {
  paymentClaim: /(pay|paid|bhar|jama|payment)\b.*\b(kar|ho|diya|done|gaya|made|did)/i,
  paymentTool: /payment|paid|dues/,
  promise: /\b(kal|parso|tomorrow|tak de|\d{1,2}\s*(tarikh|date))\b/i,
  transfer: /\b(insaan|human|agent se|manager|real person)\b/i,
  goodbye: /\b(bye|band karo|call cut|baad mein|later)\b/i,
  abusive: /\b(idiot|stupid|bakwas|pagal|bewakoof|shut up)\b/i,
  hinglishMarkers:
    /\b(hai|kar|kya|nahi|haan|ji|main|aap|diya|gaya|hoon|ho|tak|kal|paisa|mera|meri|bhai|kab|kaise|kyun)\b|[ऀ-ॿ]/i,
} as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const readableDate = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[3] ?? ''} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1] ?? ''}` : ymd;
};
const addDays = (ymd: string, days: number): string => {
  const [y = 0, m = 1, d = 1] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** Text of a JSON scalar (objects / arrays → empty). */
const str = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const tokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const systemText = (messages: ChatMessage[]) =>
  messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

const todayOf = (system: string): string => {
  const at = system.indexOf(TODAY_PREFIX);
  const found = at >= 0 ? /\d{4}-\d{2}-\d{2}/.exec(system.slice(at)) : null;
  return found?.[0] ?? new Date().toISOString().slice(0, 10);
};

const firstSentence = (text: string): string => {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?।])(\s|$)/.exec(clean);
  return (m?.[1] ?? clean).slice(0, 300);
};

const section = (system: string, heading: string): string => {
  const at = system.indexOf(heading);
  if (at < 0) return '';
  const rest = system.slice(at + heading.length);
  const next = rest.search(/\n## /);
  return (next >= 0 ? rest.slice(0, next) : rest).trim();
};

/** First tone rule for the wanted triggers, in the given priority order. */
const toneRespond = (system: string, wanted: string[]): string | null => {
  const rules = section(system, TONE_HEADING)
    .split('\n')
    .map((line) => TONE_LINE.exec(line.trim()))
    .filter((m): m is RegExpExecArray => m !== null);
  for (const w of wanted) {
    const hit = rules.find((m) => (m[1] ?? '').toLowerCase().includes(w));
    if (hit) return hit[2] ?? null;
  }
  return null;
};

const firstKnowledge = (messages: ChatMessage[]): string | null => {
  for (const m of messages) {
    const at = m.content.indexOf(KNOWLEDGE_OPEN);
    if (at < 0) continue;
    const body = m.content.slice(m.content.indexOf('\n', at) + 1);
    const end = body.indexOf(KNOWLEDGE_CLOSE);
    const text = end >= 0 ? body.slice(0, end) : body;
    if (text.trim()) return firstSentence(text);
  }
  return null;
};

const isEnglish = (text: string): boolean => !FAKE_RULES.hinglishMarkers.test(text);

type Lang = 'hinglish' | 'en';
const T = {
  paid: (l: Lang, amount: string, date: string) =>
    l === 'en'
      ? `Thank you! Our records show your payment of ₹${amount} on ${date}.`
      : `Dhanyavaad! Hamare record mein aapka ₹${amount} ka payment ${date} ko mil gaya hai.`,
  unpaid: (l: Lang) =>
    l === 'en'
      ? "We can't see the payment in our records yet. By when will you be able to pay?"
      : 'Abhi tak hamare record mein payment nahi dikh raha. Aap kab tak payment kar paayenge?',
  toolFailed: (l: Lang) =>
    l === 'en'
      ? "Sorry, I can't check that right now."
      : 'Maaf kijiye, abhi check nahi ho pa raha.',
  promise: (l: Lang, date: string) =>
    l === 'en'
      ? `Alright, I have noted your promise to pay by ${date}.`
      : `Theek hai, ${date} tak ka promise note kar liya.`,
  transfer: (l: Lang) =>
    l === 'en' ? 'I am connecting you to our team.' : 'Main aapko hamari team se jod raha hoon.',
  goodbye: (l: Lang) =>
    l === 'en' ? 'Thank you, have a good day.' : 'Dhanyavaad, aapka din shubh ho.',
  noted: (l: Lang) => (l === 'en' ? 'Noted, thank you.' : 'Ji, note kar liya.'),
  calm: (l: Lang) =>
    l === 'en'
      ? "I understand you're upset. Let's sort this out calmly."
      : 'Main samajh sakta hoon. Kripya shant rahiye, hum milkar hal nikaalte hain.',
  generic: (l: Lang, persona: string) =>
    `${l === 'en' ? 'I understand.' : 'Ji, main samajh raha hoon.'} ${persona || (l === 'en' ? 'How can I help you?' : 'Main aapki kya madad kar sakta hoon?')}`.trim(),
};

const lastOf = <T>(items: T[], pick: (item: T) => boolean): T | undefined => {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && pick(item)) return item;
  }
  return undefined;
};

const parseJson = (text: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** Required arguments of a tool, filled from the user's words (numbers) where possible. */
const argsFor = (tool: ToolDefinition, text: string, extra: Record<string, unknown> = {}) => {
  const args: Record<string, unknown> = { ...extra };
  const number = /\d+(?:\.\d+)?/.exec(text.replace(/,/g, ''))?.[0];
  for (const name of tool.parameters.required) {
    if (args[name] !== undefined) continue;
    const prop = tool.parameters.properties[name];
    if (prop?.enum?.length) args[name] = prop.enum[0];
    else if ((prop?.type === 'number' || prop?.type === 'integer') && number)
      args[name] = Number(number);
    else if (prop?.type === 'boolean') args[name] = true;
    else args[name] = '';
  }
  return args;
};

const promiseDate = (text: string, today: string): string => {
  if (/\bparso\b/i.test(text)) return addDays(today, 2);
  const day = /\b(\d{1,2})\s*(tarikh|date)\b/i.exec(text)?.[1];
  if (day) {
    const [y = 0, m = 1, d = 1] = today.split('-').map(Number);
    const target = Number(day);
    const month = target > d ? m : m + 1;
    return new Date(Date.UTC(y, month - 1, target)).toISOString().slice(0, 10);
  }
  return addDays(today, 1);
};

const replyFromTools = (messages: ChatMessage[], lang: Lang): string => {
  const results = messages.slice(messages.findLastIndex((m) => m.role === 'assistant') + 1);
  const call = lastOf(messages, (m) => m.role === 'assistant' && Boolean(m.toolCalls?.length));
  const calls = new Map((call?.toolCalls ?? []).map((c) => [c.id, c]));
  const parts: string[] = [];
  for (const r of results) {
    const tool = calls.get(r.toolCallId ?? '');
    const result = parseJson(r.content);
    if (!tool) continue;
    if (result?.ok === false) {
      parts.push(T.toolFailed(lang));
    } else if (FAKE_RULES.paymentTool.test(tool.name)) {
      const data = (result?.data ?? result ?? {}) as Record<string, unknown>;
      parts.push(
        data.status === 'paid'
          ? T.paid(lang, str(data.amountRupees), readableDate(str(data.paidOn)))
          : T.unpaid(lang),
      );
    } else if (tool.name === 'save_promise_to_pay') {
      const args = parseJson(tool.arguments) ?? {};
      parts.push(T.promise(lang, readableDate(str(args.date))));
    } else if (tool.name === 'transfer_to_human') {
      parts.push(T.transfer(lang));
    } else if (tool.name === 'end_call') {
      parts.push(T.goodbye(lang));
    } else {
      parts.push(T.noted(lang));
    }
  }
  return parts.join(' ') || T.noted(lang);
};

const call = (tool: ToolDefinition, args: Record<string, unknown>): ToolCall => ({
  id: 'call_fake_1',
  name: tool.name,
  arguments: JSON.stringify(args),
});

const decide = (request: ChatRequest): { content: string; toolCalls: ToolCall[] } => {
  const { messages } = request;
  const tools = request.tools ?? [];
  const system = systemText(messages);
  const lastUser = lastOf(messages, (m) => m.role === 'user')?.content ?? '';
  const lang: Lang = isEnglish(lastUser) ? 'en' : 'hinglish';
  const last = messages.at(-1);

  if (last?.role === 'tool') return { content: replyFromTools(messages, lang), toolCalls: [] };

  const tool = (pick: (t: ToolDefinition) => boolean) => tools.find(pick);
  const paymentTool = tool((t) => FAKE_RULES.paymentTool.test(t.name));
  if (FAKE_RULES.paymentClaim.test(lastUser) && paymentTool) {
    return { content: '', toolCalls: [call(paymentTool, argsFor(paymentTool, lastUser))] };
  }
  const promiseTool = tool((t) => t.name === 'save_promise_to_pay');
  if (FAKE_RULES.promise.test(lastUser) && promiseTool) {
    const date = promiseDate(lastUser, todayOf(system));
    return { content: '', toolCalls: [call(promiseTool, argsFor(promiseTool, '', { date }))] };
  }
  const transferTool = tool((t) => t.name === 'transfer_to_human');
  if (FAKE_RULES.transfer.test(lastUser) && transferTool) {
    return {
      content: '',
      toolCalls: [call(transferTool, { reason: 'Customer asked to speak to a person' })],
    };
  }
  if (FAKE_RULES.goodbye.test(lastUser)) {
    const endTool = tool((t) => t.name === 'end_call');
    return endTool
      ? { content: '', toolCalls: [call(endTool, { reason: 'Customer ended the conversation' })] }
      : { content: T.goodbye(lang), toolCalls: [] };
  }
  const knowledge = firstKnowledge(messages);
  if (knowledge && lastUser.trim().endsWith('?')) return { content: knowledge, toolCalls: [] };
  if (FAKE_RULES.abusive.test(lastUser)) {
    return {
      content: toneRespond(system, ['abusive', 'angry']) ?? T.calm(lang),
      toolCalls: [],
    };
  }
  return {
    content: T.generic(lang, firstSentence(section(system, PERSONA_HEADING))),
    toolCalls: [],
  };
};

/** Same words → same direction: hashed bag of words, unit length. */
export const fakeEmbedding = (text: string, dims: number = AI_LIMITS.embeddingDims): number[] => {
  const vector = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 0x811c9dc5;
    for (let i = 0; i < word.length; i += 1) {
      h ^= word.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const index = h % dims;
    vector[index] = (vector[index] ?? 0) + ((h >>> 16) & 1 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0));
  return norm ? vector.map((v) => v / norm) : vector;
};

export const createFakeProvider = (): AiProvider => ({
  name: 'fake',

  chat(request: ChatRequest): Promise<ChatResult> {
    const { content, toolCalls } = decide(request);
    const input = request.messages.reduce((s, m) => s + m.content.length, 0);
    return Promise.resolve({
      content,
      toolCalls,
      usage: {
        inputTokens: Math.max(1, Math.ceil(input / 4)),
        outputTokens: tokens(content || toolCalls.map((c) => c.name + c.arguments).join('')),
      },
      finishReason: toolCalls.length ? 'tool_calls' : 'stop',
    });
  },

  embed(request: EmbedRequest): Promise<EmbedResult> {
    return Promise.resolve({
      vectors: request.inputs.map((text) => fakeEmbedding(text)),
      usage: { tokens: request.inputs.reduce((s, t) => s + tokens(t), 0) },
    });
  },
});
