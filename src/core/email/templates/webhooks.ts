import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

export interface WebhookDisabledVars {
  accountName: string;
  /** URL host only — never the path or query. */
  host: string;
  description: string;
  webhooksUrl: string;
}

/** A webhook endpoint was turned off after repeated failures (`webhook.endpoint_disabled`). */
export const webhookEndpointDisabled = ({
  accountName,
  host,
  description,
  webhooksUrl,
}: WebhookDisabledVars): RenderedEmail => {
  const subject = `${accountName}: a webhook was turned off`;
  const name = description ? `"${description}" (${host})` : host;
  const lead = `Deliveries to ${name} kept failing, so we turned this webhook off. New events are not sent to it until you fix the receiver and turn it on again. Failed deliveries can be replayed from the delivery log.`;
  return {
    subject,
    html: renderLayout({
      title: subject,
      bodyHtml: `<p>${escapeHtml(lead)}</p>${buttonHtml(webhooksUrl, 'Open webhooks')}`,
    }),
    text: renderTextLayout(`${lead}\n\nOpen webhooks: ${webhooksUrl}`),
  };
};
