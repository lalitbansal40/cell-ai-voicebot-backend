import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isEditable } from '../../src/modules/templates/components';
import { validateTemplate, type TemplateDraftInput } from '../../src/modules/templates/validate';
import { extractVariables, renderText } from '../../src/modules/templates/variables';

const body = (text: string, examples: string[] = []) => ({
  type: 'BODY',
  text,
  ...(examples.length ? { example: { body_text: [examples] } } : {}),
});

const base = (over: Partial<TemplateDraftInput> = {}): TemplateDraftInput => ({
  name: 'order_update',
  language: 'en_US',
  category: 'UTILITY',
  parameterFormat: 'positional',
  components: [body('Hi {{1}}, your order {{2}} shipped.', ['Asha', 'ORD-1'])],
  ...over,
});

const paths = (input: TemplateDraftInput) => validateTemplate(input).errors.map((e) => e.path);

describe('validateTemplate (Meta rules, PHASE_11_PLAN §1c)', () => {
  it('a full valid template passes and returns its components', () => {
    const r = validateTemplate(
      base({
        category: 'MARKETING',
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'Sale {{1}}', example: { header_text: ['NOW'] } },
          body('Hello {{1}}, use code {{2}} today.', ['Asha', 'SAVE']),
          { type: 'FOOTER', text: 'Reply STOP to opt out' },
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'Yes' },
              { type: 'QUICK_REPLY', text: 'No' },
              {
                type: 'URL',
                text: 'Shop',
                url: 'https://shop.example.test/p/{{1}}',
                example: ['https://shop.example.test/p/42'],
              },
              { type: 'PHONE_NUMBER', text: 'Call', phone_number: '+919000000010' },
              { type: 'COPY_CODE', example: 'SAVE20' },
            ],
          },
        ],
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.components).toHaveLength(4);
  });

  const cases: [string, Partial<TemplateDraftInput>, string][] = [
    ['empty name', { name: '' }, 'name'],
    ['long name', { name: 'a'.repeat(513) }, 'name'],
    ['bad characters', { name: 'Order-Update' }, 'name'],
    ['bad language', { language: 'english' }, 'language'],
    ['authentication refused', { category: 'AUTHENTICATION' }, 'category'],
    ['ttl too small', { ttlSeconds: 10 }, 'ttlSeconds'],
    ['ttl too big', { ttlSeconds: 31 * 86_400 }, 'ttlSeconds'],
    ['no body', { components: [{ type: 'FOOTER', text: 'x' }] }, 'components.body'],
    ['two bodies', { components: [body('a'), body('b')] }, 'components.body'],
    ['body too long', { components: [body('x'.repeat(1025))] }, 'components.0.text'],
    ['unknown component', { components: [{ type: 'CAROUSEL' }] }, 'components.0'],
    [
      'two header variables',
      {
        components: [
          { type: 'HEADER', format: 'TEXT', text: '{{1}} {{2}}', example: { header_text: ['a'] } },
          body('Hi there'),
        ],
      },
      'components.header.text',
    ],
    [
      'header variable without example',
      { components: [{ type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' }, body('Hi there')] },
      'components.header.example',
    ],
    [
      'header text too long',
      { components: [{ type: 'HEADER', format: 'TEXT', text: 'x'.repeat(61) }, body('a')] },
      'components.0.text',
    ],
    [
      'body variables out of order',
      { components: [body('Hi {{2}} and {{1}}.', ['a', 'b'])] },
      'components.body.text',
    ],
    [
      'body starts with a variable',
      { components: [body('{{1}} is here', ['a'])] },
      'components.body.text',
    ],
    [
      'body ends with a variable',
      { components: [body('Hi {{1}}', ['a'])] },
      'components.body.text',
    ],
    [
      'adjacent variables',
      { components: [body('Hi {{1}}{{2}} ok', ['a', 'b'])] },
      'components.body.text',
    ],
    [
      'missing examples',
      { components: [body('Hi {{1}} and {{2}} ok', ['a'])] },
      'components.body.example',
    ],
    [
      'footer variable',
      { components: [body('Hi'), { type: 'FOOTER', text: 'Bye {{1}}' }] },
      'components.footer.text',
    ],
    [
      'location header on a marketing template is fine, on utility too',
      {
        category: 'UTILITY',
        components: [{ type: 'HEADER', format: 'LOCATION' }, body('Visit us')],
      },
      '',
    ],
    [
      'three URL buttons',
      {
        components: [
          body('Hi'),
          {
            type: 'BUTTONS',
            buttons: ['a', 'b', 'c'].map((t) => ({
              type: 'URL',
              text: t,
              url: `https://x.test/${t}`,
            })),
          },
        ],
      },
      'components.buttons',
    ],
    [
      'two phone buttons',
      {
        components: [
          body('Hi'),
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'PHONE_NUMBER', text: 'a', phone_number: '+919000000010' },
              { type: 'PHONE_NUMBER', text: 'b', phone_number: '+919000000011' },
            ],
          },
        ],
      },
      'components.buttons',
    ],
    [
      'quick replies split by another button',
      {
        components: [
          body('Hi'),
          {
            type: 'BUTTONS',
            buttons: [
              { type: 'QUICK_REPLY', text: 'a' },
              { type: 'URL', text: 'b', url: 'https://x.test' },
              { type: 'QUICK_REPLY', text: 'c' },
            ],
          },
        ],
      },
      'components.buttons',
    ],
    [
      'URL variable not at the end',
      {
        components: [
          body('Hi'),
          {
            type: 'BUTTONS',
            buttons: [
              {
                type: 'URL',
                text: 'a',
                url: 'https://x.test/{{1}}/x',
                example: ['https://x.test/1/x'],
              },
            ],
          },
        ],
      },
      'components.buttons.0.url',
    ],
    [
      'URL variable without example',
      {
        components: [
          body('Hi'),
          { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'a', url: 'https://x.test/{{1}}' }] },
        ],
      },
      'components.buttons.0.example',
    ],
    [
      'copy code example too long',
      {
        components: [
          body('Hi'),
          { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'x'.repeat(21) }] },
        ],
      },
      'components.1.buttons.0.example',
    ],
    [
      'button label too long',
      {
        components: [
          body('Hi'),
          { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'x'.repeat(26) }] },
        ],
      },
      'components.1.buttons.0.text',
    ],
    [
      'call request on a general template',
      { components: [body('Hi'), { type: 'call_permission_request' }] },
      'components',
    ],
    [
      'call permission template without the request',
      { purpose: 'call_permission', components: [body('Hi')] },
      'components',
    ],
    [
      'call permission template must be utility',
      {
        purpose: 'call_permission',
        category: 'MARKETING',
        components: [body('Hi'), { type: 'call_permission_request' }],
      },
      'category',
    ],
  ];

  it.each(cases)('%s', (_name, over, path) => {
    const got = paths(base(over));
    if (path) expect(got).toContain(path);
    else expect(got).toEqual([]);
  });

  it('location headers need utility or marketing (rule kept for other categories)', () => {
    expect(
      paths(
        base({
          category: 'AUTHENTICATION',
          components: [{ type: 'HEADER', format: 'LOCATION' }, body('Hi')],
        }),
      ),
    ).toEqual(expect.arrayContaining(['category', 'components.header.format']));
  });

  it('named variables: lower case names with examples; numbers refused', () => {
    const named = (text: string, params: { param_name: string; example: string }[]) =>
      base({
        parameterFormat: 'named',
        components: [{ type: 'BODY', text, example: { body_text_named_params: params } }],
      });
    expect(
      paths(named('Hi {{first_name}}, ok', [{ param_name: 'first_name', example: 'Asha' }])),
    ).toEqual([]);
    expect(paths(named('Hi {{first_name}}, ok', []))).toContain('components.body.example');
    expect(paths(named('Hi {{1}}, ok', [{ param_name: 'x', example: 'a' }]))).toContain(
      'components.body.text',
    );
  });

  it('caps the variables at 20', () => {
    const text = `Start ${Array.from({ length: 21 }, (_, i) => `{{${String(i + 1)}}}`).join(' and ')} end`;
    expect(
      paths(
        base({
          components: [
            body(
              text,
              Array.from({ length: 21 }, () => 'x'),
            ),
          ],
        }),
      ),
    ).toContain('components');
  });

  it('call permission template: utility body + request, no buttons', () => {
    expect(
      paths(
        base({
          purpose: 'call_permission',
          components: [body('May we call you?'), { type: 'call_permission_request' }],
        }),
      ),
    ).toEqual([]);
    expect(
      paths(
        base({
          purpose: 'call_permission',
          components: [
            body('May we call you?'),
            { type: 'call_permission_request' },
            { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Yes' }] },
          ],
        }),
      ),
    ).toContain('components.buttons');
  });
});

describe('variables', () => {
  it('extracts header / body / URL / copy code variables with examples and unique keys', () => {
    const vars = extractVariables(
      [
        {
          type: 'HEADER',
          format: 'TEXT',
          text: 'Order {{1}}',
          example: { header_text: ['ORD-1'] },
        },
        {
          type: 'BODY',
          text: 'Hi {{1}}, {{2}} items, {{1}} again.',
          example: { body_text: [['Asha', '3']] },
        },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Yes' },
            {
              type: 'URL',
              text: 'Track',
              url: 'https://x.test/t/{{1}}',
              example: ['https://x.test/t/ORD-1'],
            },
            { type: 'COPY_CODE', example: 'SAVE20' },
          ],
        },
      ],
      'positional',
    );
    expect(vars.map((v) => [v.key, v.component, v.index, v.example])).toEqual([
      ['header_1', 'header', 0, 'ORD-1'],
      ['1', 'body', 0, 'Asha'],
      ['2', 'body', 0, '3'],
      ['button_1', 'button', 1, 'ORD-1'],
      ['copy_code_2', 'button', 2, 'SAVE20'],
    ]);
    expect(vars.every((v) => v.defaultSource.kind === 'ask')).toBe(true);
  });

  it('named variables share their name across header and body', () => {
    const vars = extractVariables(
      [
        {
          type: 'HEADER',
          format: 'TEXT',
          text: 'Hi {{first_name}}',
          example: { header_text_named_params: [{ param_name: 'first_name', example: 'Asha' }] },
        },
        {
          type: 'BODY',
          text: 'Dear {{first_name}}, order {{order_id}} ok',
          example: {
            body_text_named_params: [
              { param_name: 'first_name', example: 'Asha' },
              { param_name: 'order_id', example: 'ORD-1' },
            ],
          },
        },
      ],
      'named',
    );
    expect(vars.map((v) => v.key)).toEqual(['first_name', 'order_id']);
    expect(vars[1]?.example).toBe('ORD-1');
  });

  it('renders text with values (missing ones stay)', () => {
    expect(renderText('Hi {{1}}, order {{2}}', new Map([['1', 'Asha']]))).toBe(
      'Hi Asha, order {{2}}',
    );
  });

  it('editable: our builder components only, never authentication', () => {
    expect(isEditable('UTILITY', [{ type: 'BODY', text: 'x' }])).toBe(true);
    expect(isEditable('AUTHENTICATION', [{ type: 'BODY', text: 'x' }])).toBe(false);
    expect(isEditable('MARKETING', [{ type: 'CAROUSEL' }])).toBe(false);
    expect(isEditable('MARKETING', [{ type: 'BUTTONS', buttons: [{ type: 'OTP' }] }])).toBe(false);
    expect(isEditable('MARKETING', [{ type: 'BUTTONS', buttons: [{ type: 'URL' }] }])).toBe(true);
  });
});

interface SharedCase {
  name: string;
  input: TemplateDraftInput;
  paths: string[];
}
const SHARED = (
  JSON.parse(readFileSync(join(__dirname, '../fixtures/template-validate-cases.json'), 'utf8')) as {
    cases: SharedCase[];
  }
).cases;

describe('validateTemplate shared cases (the frontend validator runs the same file)', () => {
  it.each(SHARED.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(paths(c.input).sort()).toEqual(c.paths);
  });
});
