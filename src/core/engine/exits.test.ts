import { describe, expect, it } from 'vitest';

import { NODE_TYPES } from '../../db/models/flow.model';

import {
  AI_EXITS,
  STATIC_EXITS,
  exitsOf,
  isEnding,
  isWaiting,
  optionalExits,
  requiredExits,
} from './exits';

const handles = (node: Parameters<typeof exitsOf>[0]) => exitsOf(node).map((e) => e.handle);

describe('exits', () => {
  it('declares static exits for every type; error exits are kind error', () => {
    expect(Object.keys(STATIC_EXITS).sort()).toEqual([...NODE_TYPES].sort());
    for (const type of NODE_TYPES) {
      for (const e of STATIC_EXITS[type])
        expect(e.kind).toBe(e.handle === 'error' ? 'error' : 'normal');
    }
    expect(AI_EXITS.filter((e) => e.required).map((e) => e.handle)).toEqual(['resolved']);
  });

  it('menu keys become key_<id> exits (required), digits mode uses next', () => {
    const menu = {
      type: 'gather_dtmf' as const,
      config: { keys: [{ id: 'k1', key: '1', label: 'Paid' }, { id: 'k2', key: '2' }, null, 'x'] },
    };
    expect(handles(menu)).toEqual(['key_k1', 'key_k2', 'no_input', 'invalid', 'error']);
    expect(exitsOf(menu)[0]).toMatchObject({ label: 'Press 1 · Paid', required: true });
    expect(exitsOf(menu)[1]?.label).toBe('Press 2');
    expect(exitsOf({ type: 'gather_dtmf', config: { keys: [{ id: 'k9' }] } })[0]?.label).toBe(
      'Press ?',
    );
    expect(
      handles({ type: 'gather_dtmf', config: { mode: 'digits', keys: [{ id: 'k1' }] } }),
    ).toEqual(['next', 'no_input', 'invalid', 'error']);
    expect(handles({ type: 'gather_dtmf', config: {} })).toEqual(['no_input', 'invalid', 'error']);
  });

  it('intents add intent_<id> + no_match; without intents a speech node has next', () => {
    expect(handles({ type: 'gather_speech', config: {} })).toEqual(['next', 'no_input', 'error']);
    const withIntents = {
      type: 'gather_speech' as const,
      config: {
        intents: [
          { id: 'pay', label: 'Payment' },
          { id: 'agent', label: ' ' },
        ],
      },
    };
    expect(handles(withIntents)).toEqual([
      'intent_pay',
      'intent_agent',
      'no_match',
      'no_input',
      'error',
    ]);
    expect(exitsOf(withIntents)[1]?.label).toBe('agent');
  });

  it('router rules then a required else', () => {
    const router = {
      type: 'condition_router' as const,
      config: { rules: [{ id: 'r1', label: 'Paid' }, { id: 'r2' }] },
    };
    expect(handles(router)).toEqual(['rule_r1', 'rule_r2', 'else']);
    expect(exitsOf(router).map((e) => e.label)).toEqual(['Paid', 'Rule 2', 'Else']);
    expect(requiredExits(router)).toHaveLength(3);
    expect(handles({ type: 'condition_router', config: { rules: 'nope' } })).toEqual(['else']);
  });

  it('splits required and optional', () => {
    expect(requiredExits({ type: 'api_request', config: {} }).map((e) => e.handle)).toEqual([
      'success',
    ]);
    expect(optionalExits({ type: 'api_request', config: {} }).map((e) => e.handle)).toEqual([
      'failure',
      'error',
    ]);
    expect(handles({ type: 'hangup', config: {} })).toEqual([]);
    expect(handles({ type: 'transfer_to_agent', config: {} })).toEqual([
      'failed',
      'no_answer',
      'error',
    ]);
  });

  it('knows waiting and ending nodes', () => {
    expect(NODE_TYPES.filter(isWaiting)).toEqual([
      'gather_dtmf',
      'gather_speech',
      'ai_agent',
      'transfer_to_agent',
      'wait',
    ]);
    expect(NODE_TYPES.filter(isEnding)).toEqual(['transfer_to_agent', 'hangup']);
  });
});
