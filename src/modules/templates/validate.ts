import { TEMPLATE_LIMITS } from '../../config/limits';
import type {
  ParameterFormat,
  TemplateCategory,
  TemplatePurpose,
} from '../../db/models/whatsapp-template.model';
import type { ErrorDetail } from '../../shared/errors/app-error';

import { ComponentsInputSchema, type TemplateComponentInput } from './components';
import { placeholdersIn } from './variables';

export const LANGUAGE_PATTERN = /^[a-z]{2,3}(_[A-Za-z]{2,4})?$/;
/** Meta's `message_send_ttl_seconds` range we allow (30 s – 30 days). */
export const TTL_RANGE = { min: 30, max: 30 * 86_400 } as const;

export interface TemplateDraftInput {
  name: string;
  language: string;
  category: TemplateCategory;
  parameterFormat: ParameterFormat;
  components: unknown[];
  purpose?: TemplatePurpose;
  ttlSeconds?: number | null;
}

const NAMED_KEY = /^[a-z_][a-z0-9_]*$/;
/** Meta refuses a body that starts / ends with a variable or has two side by side. */
const EDGE_VARIABLE = /^\s*\{\{[^}]+\}\}|\{\{[^}]+\}\}\s*$/;
const ADJACENT = /\}\}\s*\{\{/;

const keysOk = (keys: string[], format: ParameterFormat): boolean =>
  format === 'named'
    ? keys.every((k) => NAMED_KEY.test(k) && !/^\d+$/.test(k))
    : keys.every((k, i) => k === String(i + 1));

/**
 * Every Meta template rule we can check before submitting (PHASE_11_PLAN §1c), one
 * error per field path. Returns the parsed components when they are valid.
 */
export const validateTemplate = (
  input: TemplateDraftInput,
): { errors: ErrorDetail[]; components: TemplateComponentInput[] } => {
  const errors: ErrorDetail[] = [];
  const add = (path: string, message: string) => {
    if (!errors.some((e) => e.path === path)) errors.push({ path, message });
  };
  const format = input.parameterFormat;
  const purpose = input.purpose ?? 'general';

  if (!input.name || input.name.length > TEMPLATE_LIMITS.nameMax)
    add('name', `1–${String(TEMPLATE_LIMITS.nameMax)} characters`);
  else if (!TEMPLATE_LIMITS.namePattern.test(input.name))
    add('name', 'Use lower-case letters, numbers and _ only');
  if (!LANGUAGE_PATTERN.test(input.language)) add('language', 'Not a WhatsApp language code');
  if (input.category === 'AUTHENTICATION')
    add('category', 'Authentication templates are created in WhatsApp Manager');
  if (
    input.ttlSeconds !== undefined &&
    input.ttlSeconds !== null &&
    (!Number.isInteger(input.ttlSeconds) ||
      input.ttlSeconds < TTL_RANGE.min ||
      input.ttlSeconds > TTL_RANGE.max)
  )
    add('ttlSeconds', `Between ${String(TTL_RANGE.min)} seconds and 30 days`);

  const parsed = ComponentsInputSchema.safeParse(input.components);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      add(['components', ...issue.path.map(String)].join('.'), issue.message);
    }
    return { errors, components: [] };
  }
  const components = parsed.data;
  const count = (type: string) => components.filter((c) => c.type === type).length;
  for (const type of ['HEADER', 'FOOTER', 'BUTTONS', 'call_permission_request'] as const) {
    if (count(type) > 1) add('components', `Only one ${type.toLowerCase()} component`);
  }
  if (count('BODY') !== 1) add('components.body', 'A template needs exactly one message body');

  let variables = 0;
  const header = components.find((c) => c.type === 'HEADER');
  if (header?.format === 'TEXT') {
    const keys = placeholdersIn(header.text);
    variables += keys.length;
    if (keys.length > TEMPLATE_LIMITS.headerVariablesMax)
      add('components.header.text', 'The header can have one variable');
    else if (keys.length) {
      const example =
        format === 'named'
          ? header.example?.header_text_named_params?.[0]?.example
          : header.example?.header_text?.[0];
      if (!keysOk(keys, format)) add('components.header.text', 'Variable name format');
      if (!example) add('components.header.example', 'Add an example for the header variable');
    }
  }
  if (header?.format === 'LOCATION' && !['UTILITY', 'MARKETING'].includes(input.category))
    add('components.header.format', 'A location header needs a utility or marketing template');

  const body = components.find((c) => c.type === 'BODY');
  if (body) {
    const keys = placeholdersIn(body.text);
    const unique = [...new Set(keys)];
    variables += unique.length;
    if (unique.length) {
      if (!keysOk(unique, format)) {
        add(
          'components.body.text',
          format === 'named'
            ? 'Named variables use lower-case letters, numbers and _ (not a number)'
            : 'Number the variables {{1}}, {{2}}… in order',
        );
      }
      if (EDGE_VARIABLE.test(body.text))
        add('components.body.text', "The message can't start or end with a variable");
      if (ADJACENT.test(body.text)) add('components.body.text', 'Put text between two variables');
      const examples =
        format === 'named'
          ? new Set((body.example?.body_text_named_params ?? []).map((p) => p.param_name))
          : null;
      const positional = body.example?.body_text?.[0] ?? [];
      const missing =
        format === 'named'
          ? unique.some((k) => !examples?.has(k))
          : positional.length < unique.length;
      if (missing) add('components.body.example', 'Add an example for every variable');
    }
  }
  const footer = components.find((c) => c.type === 'FOOTER');
  if (footer && placeholdersIn(footer.text).length)
    add('components.footer.text', "The footer can't have variables");

  const buttons = components.find((c) => c.type === 'BUTTONS')?.buttons ?? [];
  const n = (type: string) => buttons.filter((b) => b.type === type).length;
  const caps: [string, number, string][] = [
    ['QUICK_REPLY', TEMPLATE_LIMITS.quickRepliesMax, 'quick replies'],
    ['URL', TEMPLATE_LIMITS.urlButtonsMax, 'website buttons'],
    ['PHONE_NUMBER', TEMPLATE_LIMITS.phoneButtonsMax, 'phone buttons'],
    ['COPY_CODE', TEMPLATE_LIMITS.copyCodeButtonsMax, 'copy code buttons'],
    ['VOICE_CALL', TEMPLATE_LIMITS.voiceCallButtonsMax, 'WhatsApp call buttons'],
  ];
  for (const [type, max, text] of caps) {
    if (n(type) > max) add('components.buttons', `At most ${String(max)} ${text}`);
  }
  // quick replies sit together, before or after all other buttons
  const kinds = buttons.map((b) => (b.type === 'QUICK_REPLY' ? 'q' : 'o')).join('');
  if (/q+o+q+|o+q+o+/.test(kinds))
    add('components.buttons', 'Keep quick replies together, before or after the other buttons');
  buttons.forEach((b, i) => {
    if (b.type !== 'URL') return;
    const keys = placeholdersIn(b.url);
    if (!keys.length) return;
    variables += 1;
    if (keys.length > 1 || !/\{\{\s*1\s*\}\}$/.test(b.url))
      add(`components.buttons.${String(i)}.url`, 'One variable {{1}}, at the end of the URL');
    if (!b.example?.[0]) add(`components.buttons.${String(i)}.example`, 'Add an example URL');
  });
  variables += n('COPY_CODE');
  if (variables > TEMPLATE_LIMITS.variablesMax)
    add('components', `At most ${String(TEMPLATE_LIMITS.variablesMax)} variables`);

  const hasPermission = count('call_permission_request') > 0;
  if (purpose === 'call_permission') {
    if (!hasPermission) add('components', 'A call permission template needs the call request');
    if (input.category !== 'UTILITY') add('category', 'Call permission templates are utility');
    if (buttons.length) add('components.buttons', "Call permission templates can't have buttons");
  } else if (hasPermission) {
    add('components', 'Use "Create call permission template" for call requests');
  }
  return { errors, components };
};
