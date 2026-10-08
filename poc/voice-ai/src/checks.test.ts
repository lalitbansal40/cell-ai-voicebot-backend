import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containsAny, detectLang, languageMatches, noAbuse, noThreats } from './checks.ts';

describe('detectLang', () => {
  it('detects Devanagari Hindi', () => assert.equal(detectLang('नमस्ते ललित जी'), 'hi'));
  it('detects English', () =>
    assert.equal(detectLang('Thank you, the payment amount is pending.'), 'en'));
  it('detects romanised Hinglish', () =>
    assert.equal(detectLang('Ji haan, aapka payment abhi pending hai'), 'hinglish'));
  it('returns unknown for empty text', () => assert.equal(detectLang('  '), 'unknown'));
});

describe('checks', () => {
  it('language match: English customer needs English reply', () => {
    assert.ok(languageMatches('en', 'Sure, I can explain the payment.').pass);
    assert.ok(!languageMatches('en', 'जी हाँ').pass);
  });
  it('containsAny is case-insensitive', () =>
    assert.ok(containsAny('x', 'Lalit Bansal ji', ['lalit']).pass));
  it('flags threat words', () => assert.ok(!noThreats('We will call the police').pass));
  it('flags abusive words', () => assert.ok(!noAbuse('तुम चोर हो').pass));
});
