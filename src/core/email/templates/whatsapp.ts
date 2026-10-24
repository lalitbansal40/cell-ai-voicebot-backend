import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

/** The business's own number is shown as its last 4 digits only. */
export interface WhatsAppChannelEmailVars {
  accountName: string;
  /** The number's label in the app. */
  label: string;
  phoneLast4: string;
  /** Human text, e.g. "Access was removed in Facebook". */
  reason: string;
  numbersUrl: string;
}

const render = (
  subject: string,
  lead: string,
  { numbersUrl }: WhatsAppChannelEmailVars,
): RenderedEmail => ({
  subject,
  html: renderLayout({
    title: subject,
    bodyHtml: `<p>${escapeHtml(lead)}</p>${buttonHtml(numbersUrl, 'Open WhatsApp numbers')}`,
  }),
  text: renderTextLayout(`${lead}\n\nOpen WhatsApp numbers: ${numbersUrl}`),
});

const numberText = (v: WhatsAppChannelEmailVars) => `"${v.label}" (…${v.phoneLast4})`;

/** Token invalid / revoked / deauthorized (`whatsapp.channel_needs_reconnect`). */
export const whatsappNeedsReconnect = (v: WhatsAppChannelEmailVars): RenderedEmail =>
  render(
    `${v.accountName}: reconnect WhatsApp number ${numberText(v)}`,
    `The WhatsApp number ${numberText(v)} needs to be connected again: ${v.reason}. Until then, this app can't send or receive its messages.`,
    v,
  );

/** Meta restricted / banned / disabled the account or number. */
export const whatsappRestricted = (v: WhatsAppChannelEmailVars): RenderedEmail =>
  render(
    `${v.accountName}: WhatsApp number ${numberText(v)} is restricted`,
    `Meta restricted the WhatsApp number ${numberText(v)}: ${v.reason}. Check WhatsApp Manager for details.`,
    v,
  );

/** Meta paused WhatsApp calling on the number (Phase 12, `whatsapp.calling_restricted`). */
export const whatsappCallingRestricted = (v: WhatsAppChannelEmailVars): RenderedEmail =>
  render(
    `${v.accountName}: WhatsApp paused calling on ${numberText(v)}`,
    `WhatsApp paused calling on the number ${numberText(v)}: ${v.reason}. Messages keep working; calls start again when the pause ends.`,
    v,
  );

/** A platform superadmin disconnected the number. */
export const whatsappAdminDisconnected = (v: WhatsAppChannelEmailVars): RenderedEmail =>
  render(
    `${v.accountName}: WhatsApp number ${numberText(v)} was disconnected`,
    `The platform team disconnected the WhatsApp number ${numberText(v)}: ${v.reason}. The number keeps working on WhatsApp; connect it again when you are ready.`,
    v,
  );
