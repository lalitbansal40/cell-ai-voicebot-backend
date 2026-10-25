import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { callHoursProblems, type CallHours } from '../../src/db/models/whatsapp-channel.model';

interface Case {
  name: string;
  input: Pick<CallHours, 'weekly' | 'holidays'>;
  problems: string[];
}

const { cases } = JSON.parse(
  readFileSync(path.join(__dirname, '../fixtures/call-hours-cases.json'), 'utf8'),
) as { cases: Case[] };

/** The same file runs against the frontend validator (`src/test/fixtures/call-hours-cases.json`). */
describe('call hours rules (shared cases)', () => {
  it('has cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });
  for (const c of cases) {
    it(c.name, () => {
      expect(callHoursProblems(c.input)).toEqual(c.problems);
    });
  }
});
