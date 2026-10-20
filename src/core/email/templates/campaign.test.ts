import { describe, expect, it } from 'vitest';

import { renderTemplate } from './index';

describe('campaign email templates', () => {
  it('escapes names, says dry run, links the campaign, has a text part', () => {
    const mail = renderTemplate('campaign.paused', {
      accountName: 'Acme <b>Loans</b>',
      campaignName: 'Oct & Nov',
      reason: 'the wallet balance ran out',
      dryRun: true,
      campaignUrl: 'http://localhost:3150/campaigns/abc',
    });
    expect(mail.subject).toBe('Acme <b>Loans</b>: campaign "Oct & Nov" paused');
    expect(mail.html).not.toContain('<b>Loans');
    expect(mail.html).toContain('Oct &amp; Nov');
    expect(mail.html).toContain('http://localhost:3150/campaigns/abc');
    expect(mail.text).toContain(
      'The dry-run campaign "Oct & Nov" paused: the wallet balance ran out. No new calls are made until it is resumed.',
    );
    const live = renderTemplate('campaign.paused', {
      accountName: 'Acme',
      campaignName: 'Oct',
      reason: 'too many calls failed in a row',
      dryRun: false,
      campaignUrl: 'http://x/campaigns/1',
    });
    expect(live.text).toMatch(/^The campaign "Oct" paused/m);
  });
});
