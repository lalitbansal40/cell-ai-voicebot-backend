import { buttonHtml } from './auth';
import { escapeHtml } from './escape';
import { renderLayout, renderTextLayout } from './layout';
import type { RenderedEmail } from './types';

export interface CampaignPausedVars {
  accountName: string;
  campaignName: string;
  /** e.g. "the wallet balance ran out". */
  reason: string;
  dryRun: boolean;
  campaignUrl: string;
}

/** A campaign paused itself (`campaign.paused`). Names only — never phones or contacts. */
export const campaignPaused = ({
  accountName,
  campaignName,
  reason,
  dryRun,
  campaignUrl,
}: CampaignPausedVars): RenderedEmail => {
  const subject = `${accountName}: campaign "${campaignName}" paused`;
  const lead = `${dryRun ? 'The dry-run campaign' : 'The campaign'} "${campaignName}" paused: ${reason}. No new calls are made until it is resumed.`;
  return {
    subject,
    html: renderLayout({
      title: subject,
      bodyHtml: `<p>${escapeHtml(lead)}</p>${buttonHtml(campaignUrl, 'Open campaign')}`,
    }),
    text: renderTextLayout(`${lead}\n\nOpen campaign: ${campaignUrl}`),
  };
};
