import { describe, expect, it } from 'vitest';

import { NODE_TYPES } from '../../db/models/flow.model';

import { NODE_CATALOG, NODE_GROUPS, flowCatalog } from './catalog';
import { parseNodeConfig } from './schema';

/** Node types whose palette defaults need a choice the user must make (agent, audio, URL …). */
const NEEDS_INPUT = [
  'play_audio',
  'ai_agent',
  'api_request',
  'condition_router',
  'set_variable',
  'transfer_to_agent',
  'send_sms',
  'send_whatsapp',
];

describe('node catalogue', () => {
  it('lists every node type once with a group, label and exits', () => {
    expect(NODE_CATALOG.map((n) => n.type)).toEqual([...NODE_TYPES]);
    for (const entry of NODE_CATALOG) {
      expect(NODE_GROUPS).toContain(entry.group);
      expect(entry.label).not.toBe('');
      expect(entry.description).not.toBe('');
    }
    const dtmf = NODE_CATALOG.find((n) => n.type === 'gather_dtmf');
    expect(dtmf).toMatchObject({ waits: true, dynamicExits: 'keys' });
    expect(NODE_CATALOG.find((n) => n.type === 'speak')?.dynamicExits).toBeNull();
  });

  it('palette defaults are complete except where the user must choose', () => {
    for (const entry of NODE_CATALOG) {
      const parsed = parseNodeConfig(entry.type, entry.defaults);
      expect(parsed.ok, entry.type).toBe(!NEEDS_INPUT.includes(entry.type));
    }
  });

  it('serves operators, dispositions, voices, system variables and limits', () => {
    const c = flowCatalog();
    expect(c.operators).toContainEqual({ operator: 'is_empty', needsValue: false });
    expect(c.operators).toContainEqual({ operator: 'equals', needsValue: true });
    expect(c.dispositions).toContain('promise_to_pay');
    expect(c.voices).toContain('coral');
    expect(c.systemVariables.map((v) => v.name)).toContain('promise_date');
    expect(c.limits.nodesMax).toBe(150);
  });
});
