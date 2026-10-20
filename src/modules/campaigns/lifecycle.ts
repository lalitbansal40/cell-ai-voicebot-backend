import type { CampaignStatus } from '../../db/models/campaign.model';

/** Allowed campaign status moves (PHASE_8_PLAN §1e); final statuses have none. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  draft: ['scheduled', 'running', 'completed', 'failed'],
  scheduled: ['draft', 'running', 'paused', 'completed', 'canceled', 'failed'],
  running: ['paused', 'completed', 'canceled', 'failed'],
  paused: ['running', 'scheduled', 'completed', 'canceled', 'failed'],
  completed: [],
  canceled: [],
  failed: [],
};

export const canMoveCampaign = (from: CampaignStatus, to: CampaignStatus): boolean =>
  CAMPAIGN_TRANSITIONS[from].includes(to);

export const isFinalCampaign = (status: CampaignStatus): boolean =>
  CAMPAIGN_TRANSITIONS[status].length === 0;

/** Settings a started (running / paused) campaign may still change (PHASE_8_PLAN §1e). */
export const LIVE_EDITABLE = [
  'name',
  'schedule.endAt',
  'window',
  'pacing',
  'retry',
  'followUps',
  'autoResume',
] as const;

export type EditRule = 'all' | 'not_mode' | 'live' | 'none';

/** What may be edited in each status. */
export const editRule = (status: CampaignStatus): EditRule => {
  if (status === 'draft') return 'all';
  if (status === 'scheduled') return 'not_mode';
  if (status === 'running' || status === 'paused') return 'live';
  return 'none';
};

/** Campaigns that may be deleted (soft) — never while they can still dial. */
export const DELETABLE: readonly CampaignStatus[] = ['draft', 'completed', 'canceled', 'failed'];
