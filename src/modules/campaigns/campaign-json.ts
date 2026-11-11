import type { Types } from 'mongoose';

import { AiAgentModel } from '../../db/models/ai-agent.model';
import type { CampaignContactDoc } from '../../db/models/campaign-contact.model';
import type { CampaignDoc, CampaignStats } from '../../db/models/campaign.model';
import { FlowAudioModel } from '../../db/models/flow-audio.model';
import { FlowModel } from '../../db/models/flow.model';
import { UserModel } from '../../db/models/user.model';

export interface CampaignNames {
  flows: Map<string, string>;
  users: Map<string, string>;
  agents?: Map<string, string>;
  /** VAPI: names of recorded-voice audio. */
  audio?: Map<string, string>;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/** Flow and user names of a page of campaigns (deleted flows keep their name). */
export const loadNames = async (
  accountId: Types.ObjectId,
  campaigns: readonly CampaignDoc[],
): Promise<CampaignNames> => {
  const flowIds = [...new Set(campaigns.flatMap((c) => (c.flowId ? [c.flowId.toString()] : [])))];
  const userIds = new Set<string>();
  for (const c of campaigns) {
    for (const id of [c.createdBy, c.startedBy, ...c.history.map((h) => h.by)]) {
      if (id) userIds.add(id.toString());
    }
  }
  const audioIds = campaigns.flatMap((c) =>
    c.voiceApi?.content?.kind === 'audio' ? [c.voiceApi.content.flowAudioId] : [],
  );
  const [agents, flows, users, audio] = await Promise.all([
    AiAgentModel.find({
      accountId,
      _id: { $in: campaigns.flatMap((c) => (c.program?.kind === 'agent' ? [c.program.id] : [])) },
    })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
    FlowModel.find({ _id: { $in: flowIds }, accountId }, null, { withDeleted: true })
      .select({ name: 1 })
      .lean<{ _id: Types.ObjectId; name: string }[]>(),
    userIds.size
      ? UserModel.find({ _id: { $in: [...userIds] } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : Promise.resolve([]),
    audioIds.length
      ? FlowAudioModel.find({ _id: { $in: audioIds }, accountId }, null, { withDeleted: true })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>()
      : Promise.resolve([]),
  ]);
  return {
    audio: new Map(audio.map((a) => [a._id.toString(), a.name])),
    agents: new Map(agents.map((a) => [a._id.toString(), a.name])),
    flows: new Map(flows.map((f) => [f._id.toString(), f.name])),
    users: new Map(users.map((u) => [u._id.toString(), u.name])),
  };
};

/** Done share of the audience (completed + failed + skipped + canceled), whole percent. */
export const progressPct = (s: CampaignStats): number =>
  s.total ? Math.floor(((s.completed + s.failed + s.skipped + s.canceled) * 100) / s.total) : 0;

/** VAPI: what a recorded-voice campaign plays (audio name or IVR name). */
const voiceLabel = (c: CampaignDoc, names: CampaignNames) => {
  const content = c.voiceApi?.content;
  if (!content) return null;
  return content.kind === 'audio'
    ? { kind: 'audio' as const, name: names.audio?.get(content.flowAudioId.toString()) ?? '' }
    : { kind: 'ivr' as const, name: content.ivrName };
};

const userRef = (id: Types.ObjectId | null, names: CampaignNames) =>
  id ? { id: id.toString(), name: names.users.get(id.toString()) ?? '' } : null;

export const toCampaignListItem = (
  c: CampaignDoc,
  names: CampaignNames,
  nextRunAt: Date | null = null,
) => ({
  id: c._id.toString(),
  name: c.name,
  line: c.line ?? 'phone',
  voice: c.line === 'voice_api' ? voiceLabel(c, names) : null,
  channelId: c.channelId?.toString() ?? null,
  talkMode: c.talkMode ?? 'ai',
  team: c.team
    ? {
        agentUserIds: c.team.agentUserIds?.map(String) ?? null,
        wrapUpSec: c.team.wrapUpSec,
      }
    : null,
  program: c.program
    ? {
        kind: c.program.kind,
        id: c.program.id.toString(),
        name:
          c.program.kind === 'agent'
            ? (names.agents?.get(c.program.id.toString()) ?? '')
            : (names.flows.get(c.program.id.toString()) ?? ''),
      }
    : null,
  askPermissionFirst: c.askPermissionFirst
    ? { templateId: c.askPermissionFirst.templateId.toString() }
    : null,
  mode: c.mode,
  status: c.status,
  pauseReason: c.pauseReason,
  waitingUntil: iso(c.waitingUntil),
  flow: {
    id: c.flowId?.toString() ?? '',
    name: names.flows.get(c.flowId?.toString() ?? '') ?? '',
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
  phoneLine: {
    callerNumberId: c.phoneLine?.callerNumberId?.toString() ?? null,
    amd: c.phoneLine?.amd ?? 'off',
    voicemailText: c.phoneLine?.voicemailText ?? null,
  },
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
  voiceApi:
    c.line === 'voice_api' && c.voiceApi
      ? {
          content: c.voiceApi.content
            ? {
                kind: c.voiceApi.content.kind,
                flowAudioId:
                  c.voiceApi.content.kind === 'audio'
                    ? c.voiceApi.content.flowAudioId.toString()
                    : null,
                ivrId: c.voiceApi.content.kind === 'ivr' ? c.voiceApi.content.ivrId : null,
                name: voiceLabel(c, names)?.name ?? '',
              }
            : null,
          audioSec: c.voiceApi.audioSec,
          retries: c.voiceApi.retries,
          retryIntervalMin: c.voiceApi.retryIntervalMin,
          batches: c.voiceApi.batches.map((b) => ({
            no: b.no,
            state: b.state,
            requestId: b.requestId,
            count: b.count,
            amountMicros: b.amountMicros,
            createdAt: b.createdAt.toISOString(),
            submittedAt: iso(b.submittedAt),
            doneAt: iso(b.doneAt),
            error: b.error,
          })),
          lastError: c.voiceApi.lastError
            ? { code: c.voiceApi.lastError.code, at: c.voiceApi.lastError.at.toISOString() }
            : null,
        }
      : null,
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
  voice: cc.voiceApi
    ? {
        batchNo: cc.voiceApi.batchNo,
        providerStatus: cc.voiceApi.providerStatus,
        durationSec: cc.voiceApi.durationSec,
        retryCount: cc.voiceApi.retryCount,
        dtmf: cc.voiceApi.dtmf,
        ivrDisposition: cc.voiceApi.ivrDisposition,
      }
    : null,
});
