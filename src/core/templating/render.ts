import { asText, isMissing } from './tokens';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface TemplateSpec<C> {
  /** Regex source (no anchors, no groups) of the tokens this template understands. */
  token: string;
  /** Value of one known token (`undefined` = missing). */
  resolve(token: string, ctx: C): unknown;
}

export interface Template<C> {
  isKnownToken(token: string): boolean;
  /** Plain text; `encode` is applied to each substituted value. */
  renderText(
    text: string,
    ctx: C,
    warnings: Set<string>,
    encode?: (value: string) => string,
  ): string;
  /** URL: every token value is URL-encoded (never changes the structure). */
  renderUrl(template: string, ctx: C, warnings: Set<string>): string;
  /** Header value: raw text; CR / LF / NUL after rendering → `null` (header injection). */
  renderHeader(template: string, ctx: C, warnings: Set<string>): string | null;
  /**
   * JSON: rendered on the parsed tree (never string concatenation). A leaf that is
   * exactly one token keeps the value's JSON type (`"{{args.amount}}"` → 500).
   */
  renderJson(template: Json, ctx: C, warnings: Set<string>): Json;
}

/**
 * Builds a renderer for one token language (Phase 5 functions, Phase 6 flows).
 * Unknown `{{…}}` placeholders are left untouched; missing values render as `''`
 * and add `missing:<token>` to `warnings`.
 */
export const createTemplate = <C>(spec: TemplateSpec<C>): Template<C> => {
  const token = new RegExp(`\\{\\{\\s*(${spec.token})\\s*\\}\\}`, 'g');
  const whole = new RegExp(`^\\{\\{\\s*(${spec.token})\\s*\\}\\}$`);
  const known = new RegExp(`^(?:${spec.token})$`);

  const renderText: Template<C>['renderText'] = (text, ctx, warnings, encode = (s) => s) =>
    text.replace(token, (_all, name: string) => {
      const value = spec.resolve(name, ctx);
      if (isMissing(value)) {
        warnings.add(`missing:${name}`);
        return '';
      }
      return encode(asText(value));
    });

  const renderJson: Template<C>['renderJson'] = (template, ctx, warnings) => {
    if (typeof template === 'string') {
      const match = whole.exec(template);
      if (match?.[1]) {
        const value = spec.resolve(match[1], ctx);
        if (isMissing(value)) {
          warnings.add(`missing:${match[1]}`);
          return '';
        }
        return typeof value === 'number' || typeof value === 'boolean' ? value : asText(value);
      }
      return renderText(template, ctx, warnings);
    }
    if (Array.isArray(template)) return template.map((item) => renderJson(item, ctx, warnings));
    if (template && typeof template === 'object') {
      return Object.fromEntries(
        Object.entries(template).map(([k, v]) => [k, renderJson(v, ctx, warnings)]),
      );
    }
    return template;
  };

  return {
    isKnownToken: (name) => known.test(name.trim()),
    renderText,
    renderUrl: (template, ctx, warnings) => renderText(template, ctx, warnings, encodeURIComponent),
    renderHeader: (template, ctx, warnings) => {
      const value = renderText(template, ctx, warnings);
      return /[\r\n\0]/.test(value) ? null : value;
    },
    renderJson,
  };
};
