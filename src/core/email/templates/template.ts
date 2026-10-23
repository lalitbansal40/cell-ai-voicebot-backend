import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

/** Template name + reason only — never template text, samples or customer data. */
export interface TemplateEmailVars {
  accountName: string;
  templateName: string;
  language: string;
  /** Our text for Meta's reason code. */
  reason: string;
  templatesUrl: string;
}

const render = (subject: string, lead: string, v: TemplateEmailVars): RenderedEmail => ({
  subject,
  html: renderLayout({
    title: subject,
    bodyHtml: `<p>${escapeHtml(lead)}</p>${buttonHtml(v.templatesUrl, 'Open WhatsApp templates')}`,
  }),
  text: renderTextLayout(`${lead}\n\nOpen WhatsApp templates: ${v.templatesUrl}`),
});

const nameOf = (v: TemplateEmailVars) => `"${v.templateName}" (${v.language})`;

/** Meta rejected a submitted template (`template.rejected`). */
export const templateRejected = (v: TemplateEmailVars): RenderedEmail =>
  render(
    'Your WhatsApp template was rejected',
    `${v.accountName}: WhatsApp rejected the template ${nameOf(v)} — ${v.reason}. Edit it and submit it again.`,
    v,
  );

/** Meta disabled a template after repeated low quality (`template.disabled`). */
export const templateDisabled = (v: TemplateEmailVars): RenderedEmail =>
  render(
    'Your WhatsApp template was disabled',
    `${v.accountName}: WhatsApp disabled the template ${nameOf(v)} — ${v.reason}. It can't be sent any more; create a new template with different content.`,
    v,
  );
