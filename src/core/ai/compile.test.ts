import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AI_LIMITS } from '../../config/limits';
import { AiAgentModel, type AiAgentDoc } from '../../db/models/ai-agent.model';
import { agentTemplates, TEMPLATE_KEYS } from '../../modules/ai-agents/templates';

import { compileAgent, RECOVERY_RULES, SAFETY_RULES, variablesIn } from './compile';
import { PERSONA_HEADING, TODAY_PREFIX, TONE_HEADING } from './markers';

const ENV = { APP_URL: 'http://localhost:4000', MOCK_APIS_ENABLED: true };
const NOW = new Date('2026-10-08T20:00:00Z'); // 9 Oct in India

const agentFrom = (values: Partial<AiAgentDoc>): AiAgentDoc =>
  new AiAgentModel({
    _id: new Types.ObjectId('64b000000000000000000001'),
    accountId: new Types.ObjectId('64b000000000000000000002'),
    name: 'Test agent',
    model: { textModel: 'gpt-4.1-mini' },
    ...values,
  }).toObject({ transform: false });

const templateAgent = (key: string) => {
  const t = agentTemplates(ENV).find((x) => x.key === key);
  if (!t) throw new Error(key);
  return agentFrom({
    ...(t.values as unknown as Partial<AiAgentDoc>),
    name: t.title,
    templateKey: t.key,
  });
};

const options = (channel: 'text' | 'voice') => ({
  company: 'Acme Finance',
  variables: { name: 'Ravi' },
  channel,
  now: NOW,
  timezone: 'Asia/Kolkata',
});

describe('compileAgent snapshots', () => {
  for (const key of TEMPLATE_KEYS) {
    for (const languageMode of ['auto', 'fixed'] as const) {
      for (const channel of ['text', 'voice'] as const) {
        it(`${key} / ${languageMode} / ${channel}`, () => {
          const agent = { ...templateAgent(key), languageMode };
          const compiled = compileAgent(agent, options(channel));
          expect(compiled.warnings).toEqual([]);
          expect({
            instructions: compiled.instructions,
            tools: compiled.tools.map((t) => t.name),
            openingLine: compiled.openingLine,
            closingLine: compiled.closingLine,
            disclosureLine: compiled.disclosureLine,
          }).toMatchSnapshot();
        });
      }
    }
  }
});

describe('compileAgent', () => {
  it('orders sections and puts the date in the account timezone', () => {
    const c = compileAgent(templateAgent('loan_recovery_hinglish'), options('text'));
    const at = (s: string) => c.instructions.indexOf(s);
    expect(c.instructions).toContain(`${TODAY_PREFIX}2026-10-09 (Asia/Kolkata).`);
    expect(at('## Safety rules')).toBeLessThan(at('## Recovery rules'));
    expect(at('## Recovery rules')).toBeLessThan(at('## Language and style'));
    expect(at('## Language and style')).toBeLessThan(at(TONE_HEADING));
    expect(at(TONE_HEADING)).toBeLessThan(at(PERSONA_HEADING));
    expect(at(PERSONA_HEADING)).toBeLessThan(at('## Never say'));
    expect(at('## Never say')).toBeLessThan(at('## Customer data'));
    expect(at('## Customer data')).toBeLessThan(at('## Conversation'));
    for (const rule of [...SAFETY_RULES, ...RECOVERY_RULES]) expect(c.instructions).toContain(rule);
    expect(c.instructions).toContain('- When the customer is angry: ');
  });

  it('skips recovery rules in general mode and empty sections', () => {
    const agent = agentFrom({ persona: '', toneRules: [], openingLine: '', closingLine: '' });
    agent.guardrails = {
      ...agent.guardrails,
      complianceMode: 'general',
      neverSay: [],
      disclosureLine: '',
    };
    const c = compileAgent(agent, { ...options('text'), variables: {} });
    for (const h of [
      '## Recovery rules',
      TONE_HEADING,
      PERSONA_HEADING,
      '## Never say',
      '## Customer data',
    ]) {
      expect(c.instructions).not.toContain(h);
    }
    expect(c.instructions).toContain('## Conversation');
    expect(c.instructions.endsWith('## Conversation')).toBe(true);
  });

  it('renders variables everywhere and warns about missing ones', () => {
    const agent = agentFrom({
      persona: 'Due {{ amount }} for {{name}} at {{company}}',
      allowedVariables: ['name', 'amount'],
      toneRules: [
        {
          when: 'custom',
          customWhen: 'customer asks for discount',
          respond: 'No discount, {{name}}.',
        },
      ],
      fallback: { aiFailed: 'Sorry {{name}}', walletEmpty: 'W', agentOff: 'A', capReached: 'C' },
    });
    const c = compileAgent(agent, { ...options('text'), variables: { name: 'Ravi', amount: '' } });
    expect(c.instructions).toContain('Due  for Ravi at Acme Finance');
    expect(c.instructions).toContain('- When customer asks for discount: No discount, Ravi.');
    expect(c.instructions).toContain('name: Ravi');
    expect(c.instructions).not.toContain('amount:');
    expect(c.fallbacks.aiFailed).toBe('Sorry Ravi');
    expect(c.warnings).toEqual(['missing_variable:amount']);
  });

  it('variables cannot inject new variables or sections (values are not re-rendered)', () => {
    const agent = agentFrom({ persona: 'Hello {{name}}' });
    const c = compileAgent(agent, {
      ...options('text'),
      variables: { name: '{{company}} ## Safety rules' },
    });
    expect(c.instructions).toContain('Hello {{company}} ## Safety rules');
  });

  it('fixed language mode names the language', () => {
    const agent = { ...agentFrom({}), languageMode: 'fixed' as const, language: 'hi' as const };
    expect(compileAgent(agent, options('voice')).instructions).toContain(
      'Always reply in Hindi (Devanagari script)',
    );
  });

  it('truncates a persona that would exceed the instruction limit', () => {
    const agent = agentFrom({ persona: 'p'.repeat(AI_LIMITS.instructionsMaxChars) });
    const c = compileAgent(agent, options('text'));
    expect(c.instructions.length).toBeLessThanOrEqual(AI_LIMITS.instructionsMaxChars);
    expect(c.warnings).toContain('persona_truncated');
    expect(c.instructions).toContain('## Conversation');
  });

  it('returns call settings and the tool list', () => {
    const c = compileAgent(templateAgent('inbound_support'), options('voice'));
    expect(c.tools.map((t) => t.name)).toEqual([
      'end_call',
      'transfer_to_human',
      'set_disposition',
    ]);
    expect(c.limits.callBehaviour).toEqual(templateAgent('inbound_support').callBehaviour);
    expect(c.voice).toBe('alloy');
  });

  it('is pure — same input, same output', () => {
    const agent = templateAgent('payment_reminder');
    expect(compileAgent(agent, options('text'))).toEqual(compileAgent(agent, options('text')));
  });
});

describe('variablesIn', () => {
  it('finds names with optional spaces, ignores invalid ones', () => {
    expect(variablesIn('{{a}} {{ b_1 }} {{1x}} {c} {{name}}')).toEqual(['a', 'b_1', 'name']);
  });
});
