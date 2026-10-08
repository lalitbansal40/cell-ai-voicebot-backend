import { describe, expect, it } from 'vitest';

import { defaultAuthorizeTopic, parseTopic } from './topics';

describe('parseTopic', () => {
  it('parses call and campaign topics', () => {
    expect(parseTopic('campaign:66F1C2A9E4B0C1D2E3F4A5B6')).toEqual({
      kind: 'campaign',
      id: '66f1c2a9e4b0c1d2e3f4a5b6',
    });
    expect(parseTopic('call:66f1c2a9e4b0c1d2e3f4a5b6')?.kind).toBe('call');
  });

  it.each(['campaign:123', 'wallet:66f1c2a9e4b0c1d2e3f4a5b6', 'campaign', ''])(
    'rejects %s',
    (t) => {
      expect(parseTopic(t)).toBeUndefined();
    },
  );

  it('default authorizer allows well-formed topics (ownership check is Phase 7/8)', () => {
    expect(defaultAuthorizeTopic({ accountId: 'a', userId: 'u' }, { kind: 'call', id: 'x' })).toBe(
      true,
    );
  });
});
