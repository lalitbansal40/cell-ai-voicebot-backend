import type { Types } from 'mongoose';

import type { CampaignContactDoc } from '../../db/models/campaign-contact.model';
import type { CampaignDoc, CampaignStats } from '../../db/models/campaign.model';
import { FlowModel } from '../../db/models/flow.model';
import { UserModel } from '../../db/models/user.model';

export interface CampaignNames {
  flows: Map<string, string>;
  users: Map<string, string>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Flow and user names of a page of campaigns (deleted flows keep their name). */
export const loadNames = async (
  accountId: Types.ObjectId,
  campaigns: readonly CampaignDoc[],
): Promise<CampaignNames> => {
  const flowIds = [...new Set(campaigns.map((c) => c.flowId.toString()))];
  const userIds = new Set<string>();
  for (const c of campaigns) {
    for (const id of [c.createdBy, c.startedBy, ...c.history.map((h) => h.by)]) {
      if (id) userIds.add(id.toString());
    }
  }
  const [flows, users] = await Promise.all([
    FlowModel.find({ _id: { $in: flowIds }, accountId }, null, { withDeleted: true })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
    userIds.size
      ? UserModel.find({ _id: { $in: [...userIds] } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : Promise.resolve([]),
  ]);
  return {
    flows: new Map(flows.map((f) => [f._id.toString(), f.name])),
    users: new Map(users.map((u) => [u._id.toString(), u.name])),
  };
};

/** Done share of the audience (completed + failed + skipped + canceled), whole percent. */
export const progressPct = (s: CampaignStats): number =>
  s.total ? Math.floor(((s.completed + s.failed + s.skipped + s.canceled) * 100) / s.total) : 0;

const userRef = (id: Types.ObjectId | null, names: CampaignNames) =>
  id ? { id: id.toString(), name: names.users.get(id.toString()) ?? '' } : null;

export const toCampaignListItem = (
  c: CampaignDoc,
  names: CampaignNames,
  nextRunAt: Date | null = null,
) => ({
  id: c._id.toString(),
  name: c.name,
  mode: c.mode,
  status: c.status,
  pauseReason: c.pauseReason,
  waitingUntil: iso(c.waitingUntil),
  flow: {
    id: c.flowId.toString(),
    name: names.flows.get(c.flowId.toString()) ?? '',
    version: c.flowVersion,
  },
  stats: c.stats,
  progressPct: progressPct(c.stats),
  spentMicros: c.stats.spentMicros,
  virtualCostMicros: c.stats.virtualCostMicros,
  nextRunAt: iso(
    nextRunAt ?? c.nextRunAt ?? (c.status === 'scheduled' ? c.schedule.startAt : null),
  ),
  parentId: c.parentId ? c.parentId.toString() : null,
  runNumber: c.runNumber,
  recurring: c.schedule.recurrence !== null,
  createdAt: c.createdAt.toISOString(),
  startedAt: iso(c.startedAt),
  completedAt: iso(c.completedAt),
});

export const toCampaignView = (
  c: CampaignDoc,
  names: CampaignNames,
  walletAvailableMicros: number,
  nextRunAt: Date | null = null,
) => ({
  ...toCampaignListItem(c, names, nextRunAt),
  revision: c.revision,
  chosenVersion: c.chosenVersion,
  versionPolicy: c.versionPolicy,
  audience: {
    listIds: c.audience.listIds.map(String),
    segmentId: c.audience.segmentId ? c.audience.segmentId.toString() : null,
    filter: c.audience.filter,
    contactIds: c.audience.contactIds.map(String),
    excludeActiveCampaigns: c.audience.excludeActiveCampaigns,
    skipIfMissing: c.audience.skipIfMissing,
  },
  schedule: {
    startAt: iso(c.schedule.startAt),
    endAt: iso(c.schedule.endAt),
    timezone: c.schedule.timezone,
    recurrence: c.schedule.recurrence
      ? { ...c.schedule.recurrence, until: iso(c.schedule.recurrence.until) }
      : null,
  },
  window: c.window,
  retry: c.retry,
  followUps: c.followUps,
  pacing: c.pacing,
  autoResume: c.autoResume,
  dryRun: c.dryRun,
  estimate: c.estimate ? { ...c.estimate, at: c.estimate.at.toISOString() } : null,
  snapshot: { done: c.snapshot.done, counts: c.snapshot.counts },
  history: c.history.map((h) => ({
    at: h.at.toISOString(),
    status: h.status,
    pauseReason: h.pauseReason,
    by: userRef(h.by, names),
  })),
  error: c.error,
  createdBy: userRef(c.createdBy, names),
  startedBy: userRef(c.startedBy, names),
  canceledAt: iso(c.canceledAt),
  pausedAt: iso(c.pausedAt),
  walletAvailableMicros,
});

/** One audience row — names + last 4 digits only (full phones go to exports only). */
export const toContactRow = (cc: CampaignContactDoc) => ({
  id: cc._id.toString(),
  contact: { id: cc.contactId.toString(), name: cc.name },
  phoneLast4: cc.phoneE164.slice(-4),
  status: cc.status,
  attempts: cc.attempts,
  lastResult: cc.lastResult,
  disposition: cc.disposition,
  promiseToPay: cc.promiseToPay,
  callback: cc.callback,
  skipReason: cc.skipReason,
  waitReason: cc.waitReason ?? null,
  nextAttemptAt: iso(cc.nextAttemptAt),
  lastCallId: cc.lastCallId ? cc.lastCallId.toString() : null,
  lastAttemptAt: iso(cc.lastAttemptAt),
  costMicros: cc.costMicros,
});
