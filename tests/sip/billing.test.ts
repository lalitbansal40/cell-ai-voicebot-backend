import { describe, expect, it } from 'vitest';

import { callCharge } from '../../src/core/billing/pricing';
import { parseCdr, reconcileCdr } from '../../src/core/telephony/sip/cdr';
import type { SipLegMetrics } from '../../src/core/telephony/sip/leg';
import { DEFAULT_RATE_CARD, type RateCardValues } from '../../src/db/models/rate-card.model';
import { trunkCostPaise, voicemailOr } from '../../src/modules/calls/call.service';
import type { CallIO } from '../../src/modules/calls/session';
import { scriptOf } from '../helpers/calls';

const card: RateCardValues = {
  ...DEFAULT_RATE_CARD,
  pulseSeconds: 60,
  callPerMinuteMicros: 600_000,
  commissionBps: 0,
};
const sec = (durationSec: number, pulseSeconds?: number) =>
  callCharge(card, { answered: true, durationSec, ...(pulseSeconds ? { pulseSeconds } : {}) })
    .breakdown.billableSeconds;

describe('SIP billing (T18.10)', () => {
  it('rounds answered seconds up to the pulse; the account pulse overrides the card', () => {
    expect([0, 1, 60, 61, 119].map((s) => sec(s))).toEqual([0, 60, 60, 120, 120]);
    expect([1, 30, 31, 61].map((s) => sec(s, 30))).toEqual([30, 30, 60, 90]);
    expect([1, 61].map((s) => sec(s, 1))).toEqual([1, 61]);
    const charge = callCharge(card, { answered: true, durationSec: 61, pulseSeconds: 30 });
    expect(charge.breakdown).toMatchObject({
      pulseSeconds: 30,
      billableSeconds: 90,
      telephonyMicros: 900_000,
    });
  });

  it('unanswered calls are free unless the card bills attempts', () => {
    expect(callCharge(card, { answered: false, durationSec: 0 }).totalMicros).toBe(0);
  });

  it('trunk cost by started minute, unknown without a rate', () => {
    expect(trunkCostPaise(61, 40)).toBe(80);
    expect(trunkCostPaise(0, 40)).toBe(0);
    expect(trunkCostPaise(61, undefined)).toBeNull();
  });

  it('reads a carrier CDR and compares minutes per day', () => {
    const cdr = parseCdr(
      [
        'Call Date,To,"Billsec"',
        '2026-11-03 10:00:00,+919000000001,61',
        '"2026-11-03 11:00:00","+91 900, quoted",30',
        '2026-11-04T09:00:00Z,+919000000002,0',
        'not a date,+91,10',
        '2026-11-04 09:00:00,+91,-5',
      ].join('\n'),
    );
    expect(cdr).toEqual([
      { day: '2026-11-03', seconds: 61 },
      { day: '2026-11-03', seconds: 30 },
      { day: '2026-11-04', seconds: 0 },
    ]);
    expect(
      reconcileCdr(cdr, [
        { day: '2026-11-03', seconds: 60 },
        { day: '2026-11-05', seconds: 120 },
      ]),
    ).toEqual([
      { day: '2026-11-03', cdrCalls: 2, cdrMinutes: 3, ourCalls: 1, ourMinutes: 1, diffMinutes: 2 },
      {
        day: '2026-11-05',
        cdrCalls: 0,
        cdrMinutes: 0,
        ourCalls: 1,
        ourMinutes: 2,
        diffMinutes: -2,
      },
    ]);
    expect(() => parseCdr('to,amount\n+91,1')).toThrow(/date column/);
  });
});

describe('answering machine message (T18.9)', () => {
  const io = () => {
    const said: string[] = [];
    const events: string[] = [];
    return {
      said,
      events,
      io: {
        say: (text: string) => {
          said.push(text);
          return Promise.resolve({ completed: true, playedMs: 100 });
        },
        event: (type: string) => events.push(type),
      } as unknown as CallIO,
    };
  };

  it('a machine hears the message once and the call ends as machine / voicemail', async () => {
    const program = scriptOf(() => Promise.resolve('hangup_node'), { disposition: 'paid' });
    const script = voicemailOr(
      program,
      { metrics: { amd: 'MACHINE' } as SipLegMetrics },
      'Please call back',
    );
    const f = io();
    expect(await script.run(f.io)).toBe('machine');
    expect(f.said).toEqual(['Please call back']);
    expect(script.result().disposition).toBe('voicemail');
    await script.stop('machine');
    expect(program.stopped).toEqual([]);
  });

  it('a person gets the program', async () => {
    const program = scriptOf(() => Promise.resolve('hangup_node'), { disposition: 'paid' });
    const script = voicemailOr(program, { metrics: { amd: 'HUMAN' } as SipLegMetrics }, 'x');
    const f = io();
    expect(await script.run(f.io)).toBe('hangup_node');
    expect(f.said).toEqual([]);
    expect(script.result().disposition).toBe('paid');
    await script.stop('customer_hangup');
    expect(program.stopped).toEqual(['customer_hangup']);
  });
});
