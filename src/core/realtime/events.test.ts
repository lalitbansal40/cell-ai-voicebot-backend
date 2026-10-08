import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createEnvelope, WS_EVENT_LIST_COMPLETE, WS_EVENT_TYPES } from './events';

const doc = readFileSync(path.resolve(__dirname, '../../../docs/conventions/websocket.md'), 'utf8');
const section = doc.slice(doc.indexOf('## 5.'), doc.indexOf('## 6.'));
const documented = [...section.matchAll(/^\| `([a-z_.]+)`/gm)].map((m) => m[1]);

describe('websocket event catalogue', () => {
  it('equals the websocket.md §5 table', () => {
    expect(WS_EVENT_LIST_COMPLETE).toBe(true);
    expect([...documented].sort()).toEqual([...WS_EVENT_TYPES].sort());
  });

  it('builds envelopes', () => {
    const env = createEnvelope('contacts.changed', { reason: 'import' });
    expect(env).toMatchObject({ type: 'contacts.changed', data: { reason: 'import' } });
    expect(env.id).toMatch(/^evt_/);
  });
});
