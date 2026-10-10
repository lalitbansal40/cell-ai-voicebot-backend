import { describe, expect, it } from 'vitest';

import { asText, createTemplate, isMissing, templateTokens } from '.';

const tpl = createTemplate<Record<string, unknown>>({
  token: '[a-z]+',
  resolve: (token, ctx) => ctx[token],
});

describe('templating', () => {
  it('lists every token, valid or not', () => {
    expect(templateTokens('{{ a }} {{B}} {{}}')).toEqual(['a', 'B', '']);
  });

  it('renders text, URLs and headers with missing warnings', () => {
    const warnings = new Set<string>();
    expect(tpl.renderText('{{a}}-{{b}}-{{X}}', { a: 1, b: null }, warnings)).toBe('1--{{X}}');
    expect([...warnings]).toEqual(['missing:b']);
    expect(tpl.renderUrl('/q?x={{a}}', { a: 'a b&c' }, new Set())).toBe('/q?x=a%20b%26c');
    expect(tpl.renderHeader('Bearer {{a}}', { a: 'x\r\ny' }, new Set())).toBeNull();
    expect(tpl.renderHeader('Bearer {{a}}', { a: 'tok' }, new Set())).toBe('Bearer tok');
  });

  it('renders JSON trees keeping the type of whole-token leaves', () => {
    const warnings = new Set<string>();
    expect(
      tpl.renderJson(
        {
          n: '{{n}}',
          b: '{{b}}',
          s: 'x {{n}}',
          o: '{{o}}',
          m: '{{m}}',
          list: ['{{n}}', 1, null, true],
        },
        { n: 5, b: false, o: { k: 1 } },
        warnings,
      ),
    ).toEqual({ n: 5, b: false, s: 'x 5', o: '', m: '', list: [5, 1, null, true] });
    expect([...warnings]).toEqual(['missing:m']);
    expect(tpl.isKnownToken(' a ')).toBe(true);
    expect(tpl.isKnownToken('A')).toBe(false);
  });

  it('helpers', () => {
    expect(asText(3)).toBe('3');
    expect(asText(true)).toBe('true');
    expect(asText({})).toBe('');
    expect(isMissing('')).toBe(true);
    expect(isMissing(0)).toBe(false);
  });
});
