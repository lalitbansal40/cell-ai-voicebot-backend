import { describe, expect, it } from 'vitest';

import { matchIntent, normalize } from './intents';

const intents = [
  { id: 'pay', keywords: ['pay kar diya', 'भुगतान'] },
  { id: 'agent', keywords: ['insaan', 'agent'] },
  { id: 'later', keywords: ['baad mein', 'pay'] },
];

describe('intents', () => {
  it('normalises case, punctuation and width but keeps Devanagari with matras', () => {
    expect(normalize('  Maine PAY kar diya!!  ')).toBe('maine pay kar diya');
    expect(normalize('ＰＡＹ')).toBe('pay');
    expect(normalize('मैंने भुगतान कर दिया।')).toBe('मैंने भुगतान कर दिया');
  });

  it('matches whole words in intent order', () => {
    expect(matchIntent('Maine pay kar diya hai', intents)).toBe('pay');
    expect(matchIntent('मैंने भुगतान कर दिया', intents)).toBe('pay');
    expect(matchIntent('kisi insaan se baat karao', intents)).toBe('agent');
    expect(matchIntent('main pay karunga', intents)).toBe('later');
    expect(matchIntent('payment', intents)).toBeNull(); // not a whole word
    expect(matchIntent('!!!', intents)).toBeNull();
    expect(matchIntent('hello', [{ id: 'x', keywords: ['!!'] }])).toBeNull();
  });
});
