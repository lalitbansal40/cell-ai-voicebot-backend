import { describe, expect, it } from 'vitest';

import {
  ceilToPaise,
  diffRateCards,
  marketFor,
  metaRate,
  parseMetaRateCsv,
  rateToMicros,
  sellingPrice,
} from '../../src/core/billing/whatsapp';
import {
  PLACEHOLDER_MARKETS,
  type RateCardMarket,
} from '../../src/db/models/whatsapp-rate-card.model';

const m = (over: Partial<RateCardMarket>): RateCardMarket => ({
  market: 'X',
  label: 'X',
  callingCodes: [],
  marketingMicros: 1_000_000,
  utilityMicros: 200_000,
  authenticationMicros: 150_000,
  authenticationInternationalMicros: null,
  serviceMicros: 100_000,
  utilityTiers: [],
  authenticationTiers: [],
  ...over,
});

describe('selling price (round up to the paisa)', () => {
  const cases: [string, Parameters<typeof sellingPrice>[0], number, number][] = [
    // name, input, price, markup
    [
      'placeholder marketing +15 %',
      { metaRateMicros: 863_100, markupBps: 1500, platformFeeMicros: 0, payer: 'platform' },
      1_000_000,
      136_900,
    ],
    [
      'placeholder utility +15 %',
      { metaRateMicros: 115_000, markupBps: 1500, platformFeeMicros: 0, payer: 'platform' },
      140_000,
      25_000,
    ],
    [
      '0.0001 rounds up to 0.01',
      { metaRateMicros: 100, markupBps: 0, platformFeeMicros: 0, payer: 'platform' },
      10_000,
      9_900,
    ],
    [
      'exact paisa stays',
      { metaRateMicros: 10_000, markupBps: 0, platformFeeMicros: 0, payer: 'platform' },
      10_000,
      0,
    ],
    [
      'zero rate is free',
      { metaRateMicros: 0, markupBps: 1500, platformFeeMicros: 0, payer: 'platform' },
      0,
      0,
    ],
    [
      'fixed price wins over markup',
      {
        metaRateMicros: 863_100,
        markupBps: 1500,
        fixedPriceMicros: 900_000,
        platformFeeMicros: 0,
        payer: 'platform',
      },
      900_000,
      36_900,
    ],
    [
      'fixed price below cost: no negative markup',
      {
        metaRateMicros: 863_100,
        markupBps: 1500,
        fixedPriceMicros: 500_000,
        platformFeeMicros: 0,
        payer: 'platform',
      },
      500_000,
      0,
    ],
    [
      'fixed price rounded up',
      {
        metaRateMicros: 1,
        markupBps: 0,
        fixedPriceMicros: 12_345,
        platformFeeMicros: 0,
        payer: 'platform',
      },
      20_000,
      19_999,
    ],
    [
      'platform fee added',
      { metaRateMicros: 115_000, markupBps: 1500, platformFeeMicros: 50_000, payer: 'platform' },
      190_000,
      25_000,
    ],
  ];
  it.each(cases)('%s', (_n, input, price, markup) => {
    const out = sellingPrice(input);
    expect(out.priceMicros).toBe(price);
    expect(out.markupMicros).toBe(markup);
    expect(out.priceMicros % 10_000).toBe(0);
  });

  it('customer pays Meta: only the platform fee (default 0 → nothing to hold)', () => {
    expect(
      sellingPrice({
        metaRateMicros: 863_100,
        markupBps: 1500,
        platformFeeMicros: 0,
        payer: 'customer',
      }),
    ).toEqual({ priceMicros: 0, metaCostMicros: 0, markupMicros: 0, platformFeeMicros: 0 });
    expect(
      sellingPrice({
        metaRateMicros: 863_100,
        markupBps: 1500,
        platformFeeMicros: 20_000,
        payer: 'customer',
      }).priceMicros,
    ).toBe(20_000);
  });

  it('ceilToPaise', () => {
    expect([0, 1, 9_999, 10_000, 10_001].map(ceilToPaise)).toEqual([
      0, 10_000, 10_000, 10_000, 20_000,
    ]);
  });
});

describe('markets', () => {
  const card = [
    m({ market: 'NORTH_AMERICA', callingCodes: ['1'] }),
    m({ market: 'JM', callingCodes: ['1876'], marketingMicros: 2_000_000 }),
    m({ market: 'IN', callingCodes: ['91'] }),
    m({ market: 'OTHER', callingCodes: [] }),
  ];
  it('longest calling code wins; unknown → OTHER', () => {
    expect(marketFor('+919000000101', card).market).toBe('IN');
    expect(marketFor('+18765550100', card).market).toBe('JM');
    expect(marketFor('+12025550100', card).market).toBe('NORTH_AMERICA');
    expect(marketFor('+447700900000', card).market).toBe('OTHER');
    expect(() => marketFor('+91', [m({ market: 'IN', callingCodes: ['91'] })])).not.toThrow();
    expect(() => marketFor('+44', [m({ market: 'IN', callingCodes: ['91'] })])).toThrow('OTHER');
  });
  it('rates per category; international authentication falls back', () => {
    const x = m({ authenticationInternationalMicros: 400_000 });
    expect(
      (
        [
          'marketing',
          'utility',
          'authentication',
          'authentication_international',
          'service',
        ] as const
      ).map((c) => metaRate(x, c)),
    ).toEqual([1_000_000, 200_000, 150_000, 400_000, 100_000]);
    expect(metaRate(m({}), 'authentication_international')).toBe(150_000);
  });
});

describe('Meta rate card CSV', () => {
  const csv = (text: string) => parseMetaRateCsv(Buffer.from(text));

  it('parses tolerant headers, rupee strings (≤ 6 decimals), known markets and calling codes', () => {
    const r = csv(
      '﻿Market,Currency,Marketing,Utility,Authentication,Authentication-International,Service\n' +
        'India,INR,0.8631,0.115,0.115,,0.115\n' +
        '"Rest of Asia Pacific",INR,₹1.20,0.20,0.20,0.40,0.10\n' +
        'Other,INR,1,0.5,0.5,n/a,0.2\n',
    );
    expect(r.errors).toEqual([
      { row: 3, message: 'Add the calling codes for "Rest of Asia Pacific"' },
    ]);
    const ok = csv(
      'market,calling codes,marketing (INR),utility,authentication,authentication international,service\n' +
        'India,91,0.8631,0.115,0.115,-,0.115\n' +
        'Rest of Asia Pacific,62;63 66,1.2,0.2,0.2,0.4,0.1\n' +
        'Other,,1,0.5,0.5,,0.2\n',
    );
    expect(ok.errors).toEqual([]);
    expect(
      ok.markets.map((x) => [
        x.market,
        x.callingCodes,
        x.marketingMicros,
        x.authenticationInternationalMicros,
      ]),
    ).toEqual([
      ['IN', ['91'], 863_100, null],
      ['REST_OF_ASIA_PACIFIC', ['62', '63', '66'], 1_200_000, 400_000],
      ['OTHER', [], 1_000_000, null],
    ]);
  });

  it('errors with row numbers: currency, bad rate, unknown / duplicate / missing columns, card rules, size', () => {
    expect(
      csv('Market,Marketing,Utility,Authentication,Service,Currency\nIndia,1,1,1,1,USD\n').errors,
    ).toEqual([{ row: 2, message: 'Only INR rate cards can be imported' }]);
    expect(
      csv('Market,Marketing,Utility,Authentication,Service\nIndia,abc,1,1,1\n').errors[0],
    ).toEqual({
      row: 2,
      message: 'Bad marketing rate "abc"',
    });
    expect(csv('Market,Marketing,Utility,Authentication,Service,Colour\n').errors).toEqual([
      { row: 1, message: 'Unknown column "Colour"' },
    ]);
    expect(
      csv('Market,Marketing,Marketing,Utility,Authentication,Service\n').errors[0]?.message,
    ).toContain('twice');
    expect(csv('Market,Marketing\n').errors.map((e) => e.message)).toEqual([
      'Missing column "utility"',
      'Missing column "authentication"',
      'Missing column "service"',
    ]);
    expect(csv('Market,Marketing,Utility,Authentication,Service\nIndia,1,1,1,1\n').errors).toEqual([
      { row: 0, message: 'Exactly one OTHER market is required' },
    ]);
    expect(csv('').errors).toEqual([{ row: 1, message: 'The file is empty' }]);
    expect(parseMetaRateCsv(Buffer.alloc(2 * 1024 * 1024 + 1)).errors[0]?.message).toContain(
      '2 MB',
    );
    expect(csv('Market,Marketing,Utility,Authentication,Service\n,1,1,1,1\n').errors[0]).toEqual({
      row: 2,
      message: 'Missing market name',
    });
  });

  it('rateToMicros: string math only', () => {
    expect(
      ['0.8631', '₹1.2', 'INR 0.000001', '12', '0.1234567', '-1', '1e-3', ''].map(rateToMicros),
    ).toEqual([863_100, 1_200_000, 1, 12_000_000, null, null, null, null]);
  });

  it('diff: added, removed, changed rates and calling codes', () => {
    const next = [
      {
        ...structuredClone(PLACEHOLDER_MARKETS[0] as RateCardMarket),
        marketingMicros: 900_000,
        callingCodes: ['91', '0091'],
      },
      m({ market: 'GB', callingCodes: ['44'] }),
    ];
    expect(diffRateCards(PLACEHOLDER_MARKETS, next)).toEqual({
      added: ['GB'],
      removed: ['OTHER'],
      changed: [
        { market: 'IN', field: 'marketingMicros', fromMicros: 863_100, toMicros: 900_000 },
        { market: 'IN', field: 'callingCodes', fromMicros: null, toMicros: null },
      ],
    });
  });
});
