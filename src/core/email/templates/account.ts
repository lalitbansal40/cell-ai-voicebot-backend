import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

export interface AccountExportReadyVars {
  accountName: string;
  url: string;
}

export interface AccountDeleteScheduledVars {
  accountName: string;
  scheduledFor: string;
  url: string;
}

export interface AccountDeleteCanceledVars {
  accountName: string;
  url: string;
}

const render = (subject: string, lead: string, label: string, url: string): RenderedEmail => ({
  subject,
  html: renderLayout({
    title: subject,
    bodyHtml: `<p>${escapeHtml(lead)}</p>${buttonHtml(url, label)}`,
  }),
  text: renderTextLayout(`${lead}\n\n${label}: ${url}`),
});

/** The whole-account archive is ready (`account.export_ready`). */
export const accountExportReady = ({ accountName, url }: AccountExportReadyVars) =>
  render(
    `${accountName}: your data export is ready`,
    'Your export is ready to download. It holds personal data, so keep it safe. The file is removed after 7 days.',
    'Open account settings',
    url,
  );

/** An owner asked to delete the account (`account.delete_scheduled`). */
export const accountDeleteScheduled = ({
  accountName,
  scheduledFor,
  url,
}: AccountDeleteScheduledVars) =>
  render(
    `${accountName} will be deleted on ${scheduledFor}`,
    `All data of ${accountName} will be permanently deleted on ${scheduledFor}. Campaigns are paused, API keys are revoked and webhooks are off. If this was a mistake, cancel it before that date.`,
    'Cancel or review',
    url,
  );

/** The deletion was canceled (`account.delete_canceled`). */
export const accountDeleteCanceled = ({ accountName, url }: AccountDeleteCanceledVars) =>
  render(
    `${accountName} will not be deleted`,
    'The deletion was canceled. Webhooks are back on. Create new API keys, as the old ones stay revoked, and resume any paused campaigns.',
    'Open account settings',
    url,
  );
