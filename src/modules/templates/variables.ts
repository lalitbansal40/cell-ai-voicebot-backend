import type { ParameterFormat, TemplateVariable } from '../../db/models/whatsapp-template.model';

import { componentOf } from './components';

/** `{{1}}` / `{{first_name}}` placeholders in order of appearance. */
export const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

export const placeholdersIn = (text: string): string[] =>
  [...text.matchAll(PLACEHOLDER)].map((m) => (m[1] ?? '').toLowerCase());

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Our unique variable keys: body = Meta's key; header = `header_<key>`; buttons by index. */
export const headerKey = (raw: string, format: ParameterFormat) =>
  format === 'named' ? raw : `header_${raw}`;
export const urlButtonKey = (index: number) => `button_${String(index)}`;
export const copyCodeKey = (index: number) => `copy_code_${String(index)}`;

const namedExamples = (example: unknown, field: string): Map<string, string> =>
  new Map(
    arr(obj(example)[field]).map((p) => [str(obj(p).param_name), str(obj(p).example)] as const),
  );

/**
 * Variables of a template (header text, body, URL suffix, copy code), with Meta's
 * examples and the default source `ask`. Keys are unique per template.
 */
export const extractVariables = (
  components: readonly Record<string, unknown>[],
  format: ParameterFormat,
): TemplateVariable[] => {
  const out: TemplateVariable[] = [];
  const seen = new Set<string>();
  const add = (v: Omit<TemplateVariable, 'defaultSource'>) => {
    if (seen.has(v.key)) return;
    seen.add(v.key);
    out.push({ ...v, defaultSource: { kind: 'ask', value: null } });
  };
  const header = componentOf(components, 'HEADER');
  if (header && str(header.format).toUpperCase() === 'TEXT') {
    const names = placeholdersIn(str(header.text));
    const ex = obj(header.example);
    const named = namedExamples(header.example, 'header_text_named_params');
    names.forEach((raw, i) =>
      add({
        key: headerKey(raw, format),
        component: 'header',
        index: 0,
        example: format === 'named' ? (named.get(raw) ?? '') : str(arr(ex.header_text)[i]),
      }),
    );
  }
  const body = componentOf(components, 'BODY');
  if (body) {
    const names = placeholdersIn(str(body.text));
    const positional = arr(arr(obj(body.example).body_text)[0]);
    const named = namedExamples(body.example, 'body_text_named_params');
    for (const raw of names) {
      add({
        key: raw,
        component: 'body',
        index: 0,
        example: format === 'named' ? (named.get(raw) ?? '') : str(positional[Number(raw) - 1]),
      });
    }
  }
  const buttons = arr(componentOf(components, 'BUTTONS')?.buttons).map(obj);
  buttons.forEach((b, index) => {
    const type = str(b.type).toUpperCase();
    if (type === 'URL' && placeholdersIn(str(b.url)).length) {
      const example = str(arr(b.example)[0]);
      const prefix = str(b.url).split('{{')[0] ?? '';
      add({
        key: urlButtonKey(index),
        component: 'button',
        index,
        // the example is a full URL: the variable is its suffix
        example: example.startsWith(prefix) ? example.slice(prefix.length) : example,
      });
    }
    if (type === 'COPY_CODE') {
      add({ key: copyCodeKey(index), component: 'button', index, example: str(b.example) });
    }
  });
  return out;
};

/** Body / header text with values filled in (missing → the placeholder stays). */
export const renderText = (
  text: string,
  values: ReadonlyMap<string, string>,
  keyOf: (raw: string) => string = (raw) => raw,
): string =>
  text.replace(PLACEHOLDER, (whole, raw: string) => values.get(keyOf(raw.toLowerCase())) ?? whole);
