import { describe, expect, it } from 'vitest';

import {
  BUILT_IN_TOOLS,
  defaultBuiltInTools,
  type BuiltInToolsConfig,
  type FunctionParam,
} from '../../db/models/ai-agent.model';

import {
  agentToolDefinitions,
  argumentsValidator,
  BUILT_IN_ARGS,
  builtInToolDefinition,
  enabledBuiltIns,
  executeBuiltIn,
  functionToolDefinition,
  parametersSchema,
} from './tools';

const PARAMS: FunctionParam[] = [
  { name: 'loan_id', type: 'string', description: 'Loan', required: true },
  { name: 'count', type: 'integer', description: 'Count', required: false },
  { name: 'ratio', type: 'number', description: 'Ratio', required: false },
  { name: 'urgent', type: 'boolean', description: 'Urgent', required: false },
  { name: 'kind', type: 'enum', description: 'Kind', required: false, enumValues: ['a', 'b'] },
];

const allOn = (): BuiltInToolsConfig => ({
  endCall: { enabled: true },
  transferToHuman: { enabled: true, phone: null, message: null },
  setDisposition: { enabled: true, allowed: ['paid', 'other'] },
  scheduleCallback: { enabled: true, maxDaysAhead: 7 },
  savePromiseToPay: { enabled: true, maxDaysAhead: 15 },
  sendSmsAfterCall: { enabled: true, templates: [{ key: 'pay_link', text: 'Pay here' }] },
});

describe('custom function tools', () => {
  it('builds a strict JSON schema', () => {
    expect(parametersSchema(PARAMS)).toEqual({
      type: 'object',
      properties: {
        loan_id: { type: 'string', description: 'Loan' },
        count: { type: 'integer', description: 'Count' },
        ratio: { type: 'number', description: 'Ratio' },
        urgent: { type: 'boolean', description: 'Urgent' },
        kind: { type: 'string', description: 'Kind', enum: ['a', 'b'] },
      },
      required: ['loan_id'],
      additionalProperties: false,
    });
  });

  it('validates arguments strictly', () => {
    const v = argumentsValidator(PARAMS);
    expect(
      v.safeParse({ loan_id: 'L1', count: 2, ratio: 0.5, urgent: true, kind: 'a' }).success,
    ).toBe(true);
    expect(v.safeParse({ loan_id: 'L1' }).success).toBe(true);
    for (const bad of [
      {},
      { loan_id: 1 },
      { loan_id: 'L1', count: 1.5 },
      { loan_id: 'L1', ratio: 'x' },
      { loan_id: 'L1', urgent: 'yes' },
      { loan_id: 'L1', kind: 'c' },
      { loan_id: 'L1', extra: 1 },
      { loan_id: 'x'.repeat(2001) },
    ]) {
      expect(v.safeParse(bad).success, JSON.stringify(bad).slice(0, 40)).toBe(false);
    }
  });

  it('adds the response hint to the description', () => {
    expect(
      functionToolDefinition({
        name: 'f',
        description: 'Does f',
        parameters: [],
        responseHint: 'Hint',
      }).description,
    ).toBe('Does f\nHint');
    expect(
      functionToolDefinition({
        name: 'f',
        description: 'Does f',
        parameters: [],
        responseHint: null,
      }).description,
    ).toBe('Does f');
  });
});

describe('built-in tools', () => {
  it('offers only enabled ones (and skips empty lists)', () => {
    expect(enabledBuiltIns({ builtInTools: allOn() })).toEqual([...BUILT_IN_TOOLS]);
    const tools = allOn();
    tools.setDisposition.allowed = [];
    tools.sendSmsAfterCall.templates = [];
    tools.endCall.enabled = false;
    expect(enabledBuiltIns({ builtInTools: tools })).toEqual([
      'transfer_to_human',
      'schedule_callback',
      'save_promise_to_pay',
    ]);
    expect(enabledBuiltIns({ builtInTools: defaultBuiltInTools() })).toEqual([
      'end_call',
      'set_disposition',
    ]);
  });

  it('describes every built-in with its settings', () => {
    const agent = { builtInTools: allOn() };
    for (const name of BUILT_IN_TOOLS) {
      const def = builtInToolDefinition(name, agent);
      expect(def.name).toBe(name);
      expect(def.parameters.additionalProperties).toBe(false);
    }
    expect(
      builtInToolDefinition('set_disposition', agent).parameters.properties.disposition,
    ).toMatchObject({
      enum: ['paid', 'other'],
    });
    expect(
      builtInToolDefinition('send_sms_after_call', agent).parameters.properties.templateKey,
    ).toMatchObject({
      enum: ['pay_link'],
    });
    expect(builtInToolDefinition('schedule_callback', agent).description).toContain('7 days');
    expect(builtInToolDefinition('save_promise_to_pay', agent).description).toContain('15 days');
  });

  it('lists custom functions first, then built-ins', () => {
    const defs = agentToolDefinitions({
      builtInTools: defaultBuiltInTools(),
      functions: [
        { name: 'lookup', description: 'L', parameters: [], responseHint: null },
      ] as never,
    });
    expect(defs.map((d) => d.name)).toEqual(['lookup', 'end_call', 'set_disposition']);
  });

  it('validates built-in arguments', () => {
    expect(BUILT_IN_ARGS.save_promise_to_pay.safeParse({ date: '2026-10-10' }).success).toBe(true);
    expect(BUILT_IN_ARGS.save_promise_to_pay.safeParse({ date: '10/10/2026' }).success).toBe(false);
    expect(
      BUILT_IN_ARGS.schedule_callback.safeParse({ date: '2026-10-10', time: '18:30' }).success,
    ).toBe(true);
    expect(
      BUILT_IN_ARGS.schedule_callback.safeParse({ date: '2026-10-10', time: '24:00' }).success,
    ).toBe(false);
    expect(BUILT_IN_ARGS.set_disposition.safeParse({ disposition: 'paid' }).success).toBe(true);
    expect(BUILT_IN_ARGS.set_disposition.safeParse({ disposition: 'won' }).success).toBe(false);
    expect(BUILT_IN_ARGS.transfer_to_human.safeParse({}).success).toBe(false);
    expect(BUILT_IN_ARGS.end_call.safeParse({ reason: 'done', x: 1 }).success).toBe(false);
    expect(BUILT_IN_ARGS.send_sms_after_call.safeParse({ templateKey: 'pay_link' }).success).toBe(
      true,
    );
  });
});

describe('executeBuiltIn (simulated)', () => {
  const ctx = (builtInTools = allOn()) => ({
    agent: { builtInTools },
    mode: 'simulated' as const,
    now: new Date('2026-10-08T19:00:00Z'), // 9 Oct in India
    timezone: 'Asia/Kolkata',
  });

  it('records outcomes for every built-in', () => {
    expect(executeBuiltIn('end_call', {}, ctx())).toEqual({
      result: { ok: true, simulated: true, ended: true },
      outcome: { endRequested: true },
    });
    expect(executeBuiltIn('transfer_to_human', { reason: 'asked' }, ctx()).outcome).toEqual({
      transferRequested: true,
    });
    expect(executeBuiltIn('set_disposition', { disposition: 'paid' }, ctx()).outcome).toEqual({
      disposition: 'paid',
    });
    expect(
      executeBuiltIn('schedule_callback', { date: '2026-10-16', time: '18:30' }, ctx()).outcome,
    ).toEqual({
      callback: { date: '2026-10-16', time: '18:30' },
    });
    expect(
      executeBuiltIn(
        'save_promise_to_pay',
        { date: '2026-10-09', amountRupees: '₹1,250.50' },
        ctx(),
      ).outcome,
    ).toEqual({ promiseToPay: { date: '2026-10-09', amountMicros: 1_250_500_000 } });
    expect(executeBuiltIn('save_promise_to_pay', { date: '2026-10-24' }, ctx()).outcome).toEqual({
      promiseToPay: { date: '2026-10-24', amountMicros: null },
    });
    expect(
      executeBuiltIn('send_sms_after_call', { templateKey: 'pay_link' }, ctx()).outcome,
    ).toEqual({
      smsTemplate: 'pay_link',
    });
  });

  it.each([
    ['schedule_callback', { date: '2026-10-08' }, 'date_out_of_range'], // yesterday in IST
    ['schedule_callback', { date: '2026-10-17' }, 'date_out_of_range'], // > 7 days
    ['schedule_callback', { date: '2026-02-30' }, 'date_out_of_range'],
    ['save_promise_to_pay', { date: '2026-10-25' }, 'date_out_of_range'], // > 15 days
    ['save_promise_to_pay', { date: '2026-10-10', amountRupees: 'twelve' }, 'invalid_amount'],
    ['set_disposition', { disposition: 'wrong_number' }, 'disposition_not_allowed'],
    ['send_sms_after_call', { templateKey: 'other' }, 'unknown_template'],
    ['transfer_to_human', {}, 'invalid_arguments'],
    ['end_call', { reason: 'x', extra: 1 }, 'invalid_arguments'],
  ] as const)('%s %j → %s', (name, args, error) => {
    const out = executeBuiltIn(name, args, ctx());
    expect(out.result).toMatchObject({ ok: false, error });
    expect(out.outcome).toEqual({});
  });

  it('refuses disabled tools and live mode', () => {
    const tools = allOn();
    tools.endCall.enabled = false;
    expect(executeBuiltIn('end_call', {}, ctx(tools)).result).toEqual({
      ok: false,
      error: 'tool_disabled',
    });
    expect(executeBuiltIn('transfer_to_human', null, ctx()).result).toMatchObject({
      error: 'invalid_arguments',
    });
    expect(() => executeBuiltIn('end_call', {}, { ...ctx(), mode: 'live' })).toThrow(/Phase 7/);
  });
});
