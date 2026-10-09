import { describe, expect, it } from 'vitest';

import { createFakeProvider, fakeEmbedding, FAKE_RULES } from './fake.provider';
import type { ChatMessage, ToolDefinition } from './types';

const fake = createFakeProvider();
const SYSTEM = [
  "Today's date: 2026-10-09 (Asia/Kolkata).",
  '## Persona',
  'Aap Demo Finance ki taraf se loan ki baat kar rahe hain. Hamesha vinamra rahiye.',
  '## Tone rules',
  '- When the customer is angry: Main aapki baat samajhta hoon, shant rahiye.',
  '- When the customer is abusive: Kripya sahi bhasha ka prayog karein.',
].join('\n');
const tool = (
  name: string,
  required: string[] = [],
  properties: ToolDefinition['parameters']['properties'] = {},
): ToolDefinition => ({
  name,
  description: name,
  parameters: { type: 'object', properties, required, additionalProperties: false },
});
const TOOLS = [
  tool('check_payment_status'),
  tool('save_promise_to_pay', ['date'], {
    date: { type: 'string' },
    amountRupees: { type: 'string' },
  }),
  tool('transfer_to_human', ['reason'], { reason: { type: 'string' } }),
  tool('end_call', [], { reason: { type: 'string' } }),
  tool('set_disposition', ['disposition'], {
    disposition: { type: 'string', enum: ['paid', 'other'] },
  }),
];
const chat = (text: string, extra: ChatMessage[] = [], tools: ToolDefinition[] = TOOLS) =>
  fake.chat({
    model: 'm',
    temperatureTenths: 6,
    maxOutputTokens: 300,
    tools,
    messages: [{ role: 'system', content: SYSTEM }, ...extra, { role: 'user', content: text }],
  });
const afterTool = (name: string, args: string, result: string, user = 'maine pay kar diya') =>
  fake.chat({
    model: 'm',
    temperatureTenths: 6,
    maxOutputTokens: 300,
    tools: TOOLS,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_fake_1', name, arguments: args }] },
      { role: 'tool', toolCallId: 'call_fake_1', content: result },
    ],
  });

describe('fake provider — rules', () => {
  it('calls the payment tool on a payment claim, then answers from the result', async () => {
    const first = await chat('Maine kal hi payment kar diya hai');
    expect(first.toolCalls).toEqual([
      { id: 'call_fake_1', name: 'check_payment_status', arguments: '{}' },
    ]);
    expect(first.finishReason).toBe('tool_calls');
    const paid = await afterTool(
      'check_payment_status',
      '{}',
      JSON.stringify({
        ok: true,
        data: { status: 'paid', amountRupees: '2,500.00', paidOn: '2026-10-08' },
      }),
    );
    expect(paid.content).toBe(
      'Dhanyavaad! Hamare record mein aapka ₹2,500.00 ka payment 08 Oct 2026 ko mil gaya hai.',
    );
    const unpaid = await afterTool(
      'check_payment_status',
      '{}',
      JSON.stringify({ status: 'unpaid' }),
    );
    expect(unpaid.content).toBe(
      'Abhi tak hamare record mein payment nahi dikh raha. Aap kab tak payment kar paayenge?',
    );
    const failed = await afterTool(
      'check_payment_status',
      '{}',
      JSON.stringify({ ok: false, error: 'timeout' }),
    );
    expect(failed.content).toBe('Maaf kijiye, abhi check nahi ho pa raha.');
    const en = await afterTool(
      'check_payment_status',
      '{}',
      JSON.stringify({ status: 'unpaid' }),
      'I already paid it',
    );
    expect(en.content).toBe(
      "We can't see the payment in our records yet. By when will you be able to pay?",
    );
  });

  it('records promises with a date from the account day', async () => {
    const kal = await chat('kal tak de dunga');
    expect(kal.toolCalls[0]).toMatchObject({
      name: 'save_promise_to_pay',
      arguments: '{"date":"2026-10-10"}',
    });
    expect((await chat('parso de dunga')).toolCalls[0]?.arguments).toBe('{"date":"2026-10-11"}');
    expect((await chat('15 tarikh ko de dunga')).toolCalls[0]?.arguments).toBe(
      '{"date":"2026-10-15"}',
    );
    expect((await chat('5 date ko de dunga')).toolCalls[0]?.arguments).toBe(
      '{"date":"2026-11-05"}',
    );
    const reply = await afterTool(
      'save_promise_to_pay',
      '{"date":"2026-10-10"}',
      '{"ok":true}',
      'kal tak de dunga',
    );
    expect(reply.content).toBe('Theek hai, 10 Oct 2026 tak ka promise note kar liya.');
  });

  it('transfers, ends, notes other tools and says goodbye without an end tool', async () => {
    expect((await chat('mujhe kisi insaan se baat karni hai')).toolCalls[0]?.name).toBe(
      'transfer_to_human',
    );
    expect(
      (await afterTool('transfer_to_human', '{}', '{"ok":true}', 'insaan se baat karni hai'))
        .content,
    ).toBe('Main aapko hamari team se jod raha hoon.');
    expect((await chat('ok bye')).toolCalls[0]?.name).toBe('end_call');
    expect((await afterTool('end_call', '{}', '{"ok":true}', 'theek hai bye')).content).toBe(
      'Dhanyavaad, aapka din shubh ho.',
    );
    expect(
      (await afterTool('set_disposition', '{"disposition":"paid"}', '{"ok":true}', 'haan')).content,
    ).toBe('Ji, note kar liya.');
    expect((await chat('bye', [], [])).content).toBe('Thank you, have a good day.');
  });

  it('answers questions from knowledge, calms abuse and falls back to the persona', async () => {
    const knowledge: ChatMessage = {
      role: 'system',
      content:
        '<<<KNOWLEDGE source="FAQ" id="c1">\nLate fee is ₹500 after 5 days. Pay via UPI.\n>>>',
    };
    expect((await chat('late fee kitni hai?', [knowledge])).content).toBe(
      'Late fee is ₹500 after 5 days.',
    );
    expect((await chat('tum pagal ho kya')).content).toBe('Kripya sahi bhasha ka prayog karein.');
    const noTone = await fake.chat({
      model: 'm',
      temperatureTenths: 6,
      maxOutputTokens: 1,
      messages: [{ role: 'user', content: 'you are stupid' }],
    });
    expect(noTone.content).toBe("I understand you're upset. Let's sort this out calmly.");
    expect((await chat('haan ji boliye')).content).toBe(
      'Ji, main samajh raha hoon. Aap Demo Finance ki taraf se loan ki baat kar rahe hain.',
    );
    const bare = await fake.chat({
      model: 'm',
      temperatureTenths: 6,
      maxOutputTokens: 1,
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(bare.content).toBe('I understand. How can I help you?');
    expect(bare.usage.inputTokens).toBeGreaterThan(0);
    expect(bare.usage.outputTokens).toBeGreaterThan(0);
  });

  it('copes with odd tool messages (unknown call id, non-JSON, array results)', async () => {
    const orphan = await fake.chat({
      model: 'm',
      temperatureTenths: 6,
      maxOutputTokens: 1,
      tools: TOOLS,
      messages: [
        { role: 'user', content: 'haan ji' },
        { role: 'tool', toolCallId: 'nope', content: 'plain text' },
      ],
    });
    expect(orphan.content).toBe('Ji, note kar liya.');
    const text = await afterTool('check_payment_status', '{}', 'not json at all');
    expect(text.content).toBe(
      'Abhi tak hamare record mein payment nahi dikh raha. Aap kab tak payment kar paayenge?',
    );
    const weird = await afterTool(
      'check_payment_status',
      '{}',
      JSON.stringify({ status: 'paid', amountRupees: { x: 1 }, paidOn: 'soon' }),
    );
    expect(weird.content).toBe(
      'Dhanyavaad! Hamare record mein aapka ₹ ka payment soon ko mil gaya hai.',
    );
  });

  it('fills required tool arguments from the message', async () => {
    const amountTool = tool('check_payment_dues', ['amount', 'kind', 'confirmed', 'note'], {
      amount: { type: 'number' },
      kind: { type: 'string', enum: ['emi', 'full'] },
      confirmed: { type: 'boolean' },
      note: { type: 'string' },
    });
    const out = await chat('maine 2,500 ka payment kar diya', [], [amountTool]);
    expect(JSON.parse(out.toolCalls[0]?.arguments ?? '{}')).toEqual({
      amount: 2500,
      kind: 'emi',
      confirmed: true,
      note: '',
    });
  });

  it('exposes its rule table', () => {
    expect(FAKE_RULES.paymentClaim.test('payment ho gaya')).toBe(true);
    expect(FAKE_RULES.hinglishMarkers.test('नमस्ते')).toBe(true);
  });
});

describe('fake embeddings', () => {
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

  it('are deterministic, unit length and closer for shared words', async () => {
    const a = fakeEmbedding('late fee is 500 rupees');
    expect(fakeEmbedding('late fee is 500 rupees')).toEqual(a);
    expect(a).toHaveLength(1536);
    expect(dot(a, a)).toBeCloseTo(1, 6);
    expect(dot(a, fakeEmbedding('what is the late fee'))).toBeGreaterThan(
      dot(a, fakeEmbedding('office timings monday')),
    );
    expect(fakeEmbedding('')).toEqual(new Array(1536).fill(0));
    const out = await fake.embed({ model: 'm', inputs: ['abcd', 'abcdefgh'] });
    expect(out.vectors).toHaveLength(2);
    expect(out.usage.tokens).toBe(3);
  });
});
