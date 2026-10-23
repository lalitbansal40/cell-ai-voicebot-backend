import { z } from 'zod';

import { TEMPLATE_LIMITS } from '../../config/limits';

/**
 * Meta template components (Cloud API "Message templates" reference). Two levels:
 * `StoredComponentsSchema` accepts whatever Meta returns (sync keeps unknown kinds,
 * read-only); `ComponentsInputSchema` is what our builder may submit.
 */

export const StoredComponentsSchema = z
  .array(z.looseObject({ type: z.string().min(1).max(60) }))
  .max(20);

const namedExample = z.object({
  param_name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  example: z.string().min(1).max(TEMPLATE_LIMITS.variableValueMax),
});

const HeaderText = z.object({
  type: z.literal('HEADER'),
  format: z.literal('TEXT'),
  text: z.string().min(1).max(TEMPLATE_LIMITS.headerTextMax),
  example: z
    .object({
      header_text: z.array(z.string().min(1)).max(1).optional(),
      header_text_named_params: z.array(namedExample).max(1).optional(),
    })
    .optional(),
});

const HeaderMedia = z.object({
  type: z.literal('HEADER'),
  format: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
  /** Filled by the service from the uploaded example (`header_handle`). */
  example: z.object({ header_handle: z.array(z.string().min(1)).length(1) }).optional(),
});

const HeaderLocation = z.object({ type: z.literal('HEADER'), format: z.literal('LOCATION') });

const Body = z.object({
  type: z.literal('BODY'),
  text: z.string().min(1).max(TEMPLATE_LIMITS.bodyMax),
  example: z
    .object({
      body_text: z
        .array(z.array(z.string().min(1)))
        .max(1)
        .optional(),
      body_text_named_params: z.array(namedExample).optional(),
    })
    .optional(),
});

const Footer = z.object({
  type: z.literal('FOOTER'),
  text: z.string().min(1).max(TEMPLATE_LIMITS.footerMax),
});

const label = z.string().min(1).max(TEMPLATE_LIMITS.buttonTextMax);

const QuickReply = z.object({ type: z.literal('QUICK_REPLY'), text: label });
const UrlButton = z.object({
  type: z.literal('URL'),
  text: label,
  url: z.url().max(TEMPLATE_LIMITS.urlMax),
  example: z.array(z.url()).max(1).optional(),
});
const PhoneButton = z.object({
  type: z.literal('PHONE_NUMBER'),
  text: label,
  phone_number: z
    .string()
    .regex(/^\+?\d{6,19}$/)
    .max(TEMPLATE_LIMITS.phoneMax),
});
const CopyCode = z.object({
  type: z.literal('COPY_CODE'),
  example: z.string().min(1).max(TEMPLATE_LIMITS.copyCodeExampleMax),
});
const VoiceCall = z.object({ type: z.literal('VOICE_CALL'), text: label });

export const ButtonSchema = z.discriminatedUnion('type', [
  QuickReply,
  UrlButton,
  PhoneButton,
  CopyCode,
  VoiceCall,
]);
export type TemplateButton = z.infer<typeof ButtonSchema>;

const Buttons = z.object({
  type: z.literal('BUTTONS'),
  buttons: z.array(ButtonSchema).min(1).max(TEMPLATE_LIMITS.buttonsMax),
});

/** The Phase 12 "may we call you?" component (Meta: lower case type). */
const CallPermission = z.object({ type: z.literal('call_permission_request') });

export const ComponentInputSchema = z.union([
  HeaderText,
  HeaderMedia,
  HeaderLocation,
  Body,
  Footer,
  Buttons,
  CallPermission,
]);
export type TemplateComponentInput = z.infer<typeof ComponentInputSchema>;

export const ComponentsInputSchema = z.array(ComponentInputSchema).min(1).max(6);

/** Component kinds our builder edits; anything else (carousel, limited-time offer…) is read-only. */
const EDITABLE_KINDS = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS', 'CALL_PERMISSION_REQUEST']);
const EDITABLE_BUTTONS = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE', 'VOICE_CALL']);

/** Can our builder edit these components (authentication templates never)? */
export const isEditable = (category: string, components: readonly Record<string, unknown>[]) =>
  category !== 'AUTHENTICATION' &&
  components.every((c) => {
    const kind = String(c.type).toUpperCase();
    if (!EDITABLE_KINDS.has(kind)) return false;
    if (kind !== 'BUTTONS') return true;
    const buttons = Array.isArray(c.buttons) ? (c.buttons as { type?: unknown }[]) : [];
    return buttons.every((b) => EDITABLE_BUTTONS.has(String(b.type).toUpperCase()));
  });

export const componentOf = (
  components: readonly Record<string, unknown>[],
  kind: string,
): Record<string, unknown> | undefined =>
  components.find((c) => String(c.type).toUpperCase() === kind);

/** `TEXT` / `IMAGE` / `VIDEO` / `DOCUMENT` / `LOCATION`, or '' without a header. */
export const headerFormat = (components: readonly Record<string, unknown>[]): string => {
  const format = componentOf(components, 'HEADER')?.format;
  return typeof format === 'string' ? format.toUpperCase() : '';
};
