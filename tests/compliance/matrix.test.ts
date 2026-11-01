import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { decideDial, type DialFacts } from '../../src/modules/campaigns/dial-guard';
import { canDialAt } from '../../src/modules/campaigns/window';

const root = path.resolve(__dirname, '..', '..');

const PATHS = [
  'web_test',
  'dry_run',
  'campaign',
  'api_calls',
  'whatsapp_agent_call',
  'whatsapp_ai_call',
  'inbox_send',
  'api_send',
  'after_call_send',
  'import',
] as const;
const RULES = [
  'window',
  'dnd',
  'opt_out',
  'suppression',
  'ai_disclosure',
  'recording_notice',
  'marketing_frequency',
  'whatsapp_24h',
  'consent_warning',
] as const;
type PathName = (typeof PATHS)[number];
type RuleName = (typeof RULES)[number];

/** A cell names the test proving it (the phrase must be there), or says why it can't apply. */
type Cell = { test: string; has: string } | { na: string };

const na = (reason: string): Cell => ({ na: reason });
const t = (test: string, has: string): Cell => ({ test, has });

const NOT_A_CALL = na('No call is made here');
const NOT_A_SEND = na('No WhatsApp message is sent here');
const NO_CUSTOMER = na('A team member on a test line, never a customer');

const DIAL_RULES = (test: string, window: string, dnd: string, optOut: string) => ({
  window: t(test, window),
  dnd: t(test, dnd),
  opt_out: t(test, optOut),
  suppression: t('tests/privacy/erase-leak.test.ts', 'isPhoneOnDnd'),
  ai_disclosure: t('src/core/ai/compile.test.ts', 'disclosure'),
  recording_notice: t('tests/calls/session.test.ts', 'recording'),
  marketing_frequency: NOT_A_SEND,
  whatsapp_24h: NOT_A_SEND,
  consent_warning: NOT_A_SEND,
});

const SEND_RULES = (test: string): Partial<Record<RuleName, Cell>> => ({
  window: na('WhatsApp messages have no calling window; the 24-hour window applies'),
  ai_disclosure: NOT_A_CALL,
  recording_notice: NOT_A_CALL,
  dnd: t(test, 'TEMPLATE_MARKETING_BLOCKED'),
  opt_out: t(test, 'TEMPLATE_MARKETING_BLOCKED'),
  suppression: t('tests/compliance/compliance.test.ts', 'suppressed number'),
  marketing_frequency: t('tests/templates/send.test.ts', 'arketing'),
  whatsapp_24h: t(test, 'WHATSAPP_WINDOW_CLOSED'),
  consent_warning: t('tests/compliance/compliance.test.ts', 'no_consent'),
});

const MATRIX: Record<PathName, Partial<Record<RuleName, Cell>>> = {
  web_test: {
    window: NO_CUSTOMER,
    dnd: NO_CUSTOMER,
    opt_out: NO_CUSTOMER,
    suppression: NO_CUSTOMER,
    ai_disclosure: t('src/core/ai/compile.test.ts', 'disclosure'),
    recording_notice: t('tests/calls/session.test.ts', 'recording'),
    marketing_frequency: NOT_A_SEND,
    whatsapp_24h: NOT_A_SEND,
    consent_warning: NOT_A_SEND,
  },
  dry_run: DIAL_RULES('tests/campaigns/dial-guard.test.ts', 'window', 'dnd', 'opted_out'),
  campaign: DIAL_RULES('tests/campaigns/dial-guard.test.ts', 'window', 'dnd', 'opted_out'),
  api_calls: DIAL_RULES(
    'tests/campaigns/api.test.ts',
    'CALL_OUTSIDE_WINDOW',
    'CALL_NOT_ALLOWED',
    'CALL_NOT_ALLOWED',
  ),
  whatsapp_agent_call: DIAL_RULES(
    'tests/calls-wa/outbound.test.ts',
    'CALL_OUTSIDE_WINDOW',
    'CALL_NOT_ALLOWED',
    'CALL_NOT_ALLOWED',
  ),
  whatsapp_ai_call: DIAL_RULES(
    'tests/calls-wa/outbound.test.ts',
    'CALL_OUTSIDE_WINDOW',
    'CALL_NOT_ALLOWED',
    'CALL_NOT_ALLOWED',
  ),
  inbox_send: SEND_RULES('tests/templates/send.test.ts'),
  api_send: SEND_RULES('tests/public-api/send.test.ts'),
  after_call_send: {
    ...SEND_RULES('tests/templates/send.test.ts'),
    window: t('tests/compliance/compliance.test.ts', 'next_window_hour'),
  },
  import: {
    window: na('Importing contacts contacts nobody'),
    dnd: t('tests/contact-imports/run.test.ts', 'dnd'),
    opt_out: t('tests/compliance/compliance.test.ts', 'suppressed number'),
    suppression: t('tests/privacy/erase-leak.test.ts', 'suppressed'),
    ai_disclosure: NOT_A_CALL,
    recording_notice: NOT_A_CALL,
    marketing_frequency: NOT_A_SEND,
    whatsapp_24h: NOT_A_SEND,
    consent_warning: t('tests/contact-imports/run.test.ts', 'consent'),
  },
};

describe('compliance matrix: path × rule', () => {
  it('every cell names a test or says why it does not apply', () => {
    const missing: string[] = [];
    for (const p of PATHS) {
      for (const r of RULES) if (!MATRIX[p][r]) missing.push(`${p} × ${r}`);
    }
    expect(missing).toEqual([]);
  });

  for (const p of PATHS) {
    for (const r of RULES) {
      const cell = MATRIX[p][r];
      if (!cell || 'na' in cell) continue;
      it(`${p} × ${r}: ${cell.test}`, () => {
        const file = path.join(root, cell.test);
        expect(existsSync(file), cell.test).toBe(true);
        expect(readFileSync(file, 'utf8')).toContain(cell.has);
      });
    }
  }
});

describe('the shared dial guard, rule by rule', () => {
  const window = { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] };
  const tz = 'Asia/Kolkata';
  // Monday 2 Nov 2026, in India time
  const at = (hhmm: string) => new Date(`2026-11-02T${hhmm}:00+05:30`);
  const facts = (over: Partial<DialFacts> = {}): DialFacts => ({
    now: at('10:00'),
    accountStatus: 'active',
    campaignStatus: null,
    window,
    timezone: tz,
    endAt: null,
    contact: { deleted: false, optedOut: false },
    phoneValid: true,
    dnd: false,
    counts: { today: 0, week: 0, lastCallAt: null },
    caps: { perDay: 3, perWeek: 10, minGapMinutes: 0 },
    money: 'ok',
    ...over,
  });

  it('holds the window in the account timezone: first minute, last minute, closed day', () => {
    expect(canDialAt(at('08:59'), window, tz)).toBe(false);
    expect(canDialAt(at('09:00'), window, tz)).toBe(true);
    // the last minute itself, and a new call must also leave time before the end
    expect(canDialAt(at('18:59'), window, tz, 0)).toBe(true);
    expect(canDialAt(at('19:00'), window, tz, 0)).toBe(false);
    expect(canDialAt(at('18:59'), window, tz)).toBe(false);
    expect(canDialAt(new Date('2026-11-01T10:00:00+05:30'), window, tz)).toBe(false); // Sunday
    expect(canDialAt(at('10:00'), window, 'America/New_York')).toBe(false);
  });

  it('dials only when every rule passes', () => {
    expect(decideDial(facts())).toEqual({ kind: 'dial' });
    expect(decideDial(facts({ dnd: true }))).toEqual({ kind: 'skip', reason: 'dnd' });
    expect(decideDial(facts({ contact: { deleted: false, optedOut: true } }))).toEqual({
      kind: 'skip',
      reason: 'opted_out',
    });
    expect(decideDial(facts({ now: at('20:00') })).kind).not.toBe('dial');
  });
});
