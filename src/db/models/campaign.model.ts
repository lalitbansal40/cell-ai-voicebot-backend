import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { softDeletePlugin } from '../plugins/soft-delete';
import { tenantPlugin } from '../plugins/tenant';

import { DISPOSITIONS } from './ai-agent.model';

export const CAMPAIGN_MODES = ['dry_run', 'live'] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number];

export const CAMPAIGN_STATUSES = [
  'draft',
  'scheduled',
  'running',
  'paused',
  'completed',
  'canceled',
  'failed',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
/** Campaigns that still dial or will (count against the active limit, keep their flow in use). */
export const ACTIVE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = [
  'scheduled',
  'running',
  'paused',
];

export const PAUSE_REASONS = [
  'manual',
  'wallet_empty',
  'budget_reached',
  'account_suspended',
  'too_many_failures',
  'admin',
  /** The pinned flow version can't run any more (an AI agent switched off, audio gone). */
  'flow_not_runnable',
  /** VAPI: the voice provider refused a batch / our login / credits (see `voiceApi.lastError`). */
  'provider_error',
  /** VAPI: a submit got no answer; a superadmin decides whether it reached the provider. */
  'provider_uncertain',
] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const CAMPAIGN_PRIORITIES = ['high', 'normal', 'low'] as const;
export type CampaignPriority = (typeof CAMPAIGN_PRIORITIES)[number];

export const RETRY_ON = ['no_answer', 'busy', 'failed', 'no_outcome'] as const;
export type RetryOn = (typeof RETRY_ON)[number];

export const VERSION_POLICIES = ['pinned', 'latest'] as const;
export type VersionPolicy = (typeof VERSION_POLICIES)[number];

export const RECURRENCE_FREQS = ['daily', 'weekly'] as const;
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

/** Pre-answer outcomes of a dry-run call (basis points, sum 10 000). */
export const DRY_RUN_OUTCOMES = [
  'answered',
  'no_answer',
  'busy',
  'failed',
  'invalid_number',
] as const;
export type DryRunOutcome = (typeof DRY_RUN_OUTCOMES)[number];

/** Simulated customer behaviours (PHASE_8_PROMPT §1 "Simulated customer"). */
export const SCENARIO_KEYS = [
  'paid',
  'promise',
  'refuse',
  'callback',
  'silence',
  'wrong_number',
  'hangup_early',
  'wrong_keys',
] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export const SKIP_REASONS = [
  'contact_deleted',
  'dnd',
  'opted_out',
  'invalid_phone',
  'duplicate_phone',
  'in_active_campaign',
  'missing_values',
  'cap_reached',
  'campaign_ended',
  // Phase 18: SIP line
  'rejected',
  'number_not_allowed',
  'no_call_permission',
  'unanswered_limit',
  // VAPI: the voice provider calls 10-digit Indian mobiles only
  'not_indian_mobile',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface CampaignWindow {
  /** `HH:mm`, campaign timezone; `[start, end)`. */
  start: string;
  end: string;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
}

export interface CampaignAudience {
  listIds: Types.ObjectId[];
  segmentId: Types.ObjectId | null;
  /** A Phase 3 `ContactFilter` (validated by the campaigns schema). */
  filter: Record<string, unknown> | null;
  contactIds: Types.ObjectId[];
  excludeActiveCampaigns: boolean;
  /** Contact field keys: contacts with an empty value are skipped (`missing_values`). */
  skipIfMissing: string[];
}

export interface CampaignRecurrence {
  freq: RecurrenceFreq;
  days: number[];
  time: string;
  until: Date | null;
}

export interface CampaignSchedule {
  /** `null` = start now. */
  startAt: Date | null;
  endAt: Date | null;
  timezone: string;
  recurrence: CampaignRecurrence | null;
}

export interface CampaignRetry {
  maxAttempts: number;
  intervalMinutes: number;
  retryOn: RetryOn[];
}

export interface CampaignFollowUps {
  callbacks: boolean;
  callbackMaxDays: number;
  promiseCheck: { enabled: boolean; daysAfter: number };
}

export interface CampaignPacing {
  concurrency: number;
  dialsPerMinute: number;
  priority: CampaignPriority;
}

export interface CampaignDryRun {
  mix: Record<DryRunOutcome, number>;
  scenarios: Record<ScenarioKey, number>;
  speed: number;
}

export interface CampaignStats {
  total: number;
  pending: number;
  queued: number;
  calling: number;
  waiting: number;
  completed: number;
  failed: number;
  skipped: number;
  canceled: number;
  answered: number;
  attempts: number;
  dispositions: Record<string, number>;
  skippedBy: Record<string, number>;
  spentMicros: number;
  virtualCostMicros: number;
  /** Technical failures in a row (circuit breaker); reset by any answered call. */
  failureStreak: number;
}

export interface CampaignEstimate {
  contacts: number;
  calls: number;
  perCallMicros: number;
  totalMicros: number;
  minMicros: number;
  maxMicros: number;
  at: Date;
}

export interface CampaignHistoryEntry {
  at: Date;
  status: CampaignStatus;
  pauseReason: PauseReason | null;
  by: Types.ObjectId | null;
}

export const CAMPAIGN_AMD_MODES = ['off', 'hangup', 'leave_message'] as const;
export type CampaignAmdMode = (typeof CAMPAIGN_AMD_MODES)[number];

export interface CampaignPhoneLine {
  /** One of the account's numbers; `null` = the account's first number (else the line default). */
  callerNumberId: Types.ObjectId | null;
  amd: CampaignAmdMode;
  /** Spoken once to an answering machine when `amd` is `leave_message`. */
  voicemailText: string | null;
}

export const defaultPhoneLine = (): CampaignPhoneLine => ({
  callerNumberId: null,
  amd: 'off',
  voicemailText: null,
});

/** VAPI: lines a call campaign can use (`voice_api` = recorded voice / IVR via Cell24x7). */
export const CAMPAIGN_LINES = ['phone', 'whatsapp', 'voice_api'] as const;
export type CampaignLine = (typeof CAMPAIGN_LINES)[number];

export type VoiceApiContent =
  { kind: 'audio'; flowAudioId: Types.ObjectId } | { kind: 'ivr'; ivrId: number; ivrName: string };

export const VOICE_BATCH_STATES = [
  'holding',
  'submitting',
  'open',
  'done',
  'uncertain',
  'failed',
] as const;
export type VoiceBatchState = (typeof VOICE_BATCH_STATES)[number];

/** One Cell24x7 submit (`broadcast_name = cav-<campaignId>-<no>`). */
export interface VoiceBatch {
  no: number;
  state: VoiceBatchState;
  requestId: string | null;
  count: number;
  holdId: Types.ObjectId | null;
  amountMicros: number;
  createdAt: Date;
  submittedAt: Date | null;
  doneAt: Date | null;
  lastPolledAt: Date | null;
  /** Error code of a failed / uncertain submit. */
  error: string | null;
}

/** Recorded-voice settings and batches of a `voice_api` campaign. */
export interface CampaignVoiceApi {
  /** `null` while a draft has no audio / IVR chosen yet. */
  content: VoiceApiContent | null;
  /** Seconds billed per number: the audio's length, or the account's IVR estimate. */
  audioSec: number;
  retries: number;
  retryIntervalMin: number;
  nextBatchNo: number;
  batches: VoiceBatch[];
  lastError: { code: string; at: Date } | null;
}

/** Who talks on a call campaign's calls: the AI (flow / agent) or team members (CM). */
export const TALK_MODES = ['ai', 'team'] as const;
export type TalkMode = (typeof TALK_MODES)[number];

export const TEAM_LIMITS = { wrapUpMaxSec: 120, wrapUpDefaultSec: 15, agentsMax: 100 } as const;

/** Team calling: who may join the campaign's calling session and the pause after each call. */
export interface CampaignTeam {
  /** `null` = every active member who may place calls. */
  agentUserIds: Types.ObjectId[] | null;
  wrapUpSec: number;
}

export interface CampaignDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  name: string;
  mode: CampaignMode;
  flowId: Types.ObjectId | null;
  line?: CampaignLine;
  /** VAPI: only for `line: 'voice_api'`. */
  voiceApi?: CampaignVoiceApi | null;
  channelId?: Types.ObjectId | null;
  program?: { kind: 'flow' | 'agent'; id: Types.ObjectId } | null;
  /** CM: `team` = members talk (phone / WhatsApp call campaigns, live only). Missing = `ai`. */
  talkMode?: TalkMode;
  team?: CampaignTeam | null;
  askPermissionFirst?: { templateId: Types.ObjectId } | null;
  /** Set at start (pinned); `null` before. */
  flowVersionId: Types.ObjectId | null;
  /** Version number the pinned version has (display). */
  flowVersion: number | null;
  /** A chosen version number, or `null` = the latest published at start. */
  chosenVersion: number | null;
  versionPolicy: VersionPolicy;
  audience: CampaignAudience;
  schedule: CampaignSchedule;
  window: CampaignWindow;
  retry: CampaignRetry;
  followUps: CampaignFollowUps;
  pacing: CampaignPacing;
  autoResume: boolean;
  /** Phase 18: caller number and answering machine handling on the SIP line. */
  phoneLine?: CampaignPhoneLine;
  dryRun: CampaignDryRun | null;
  status: CampaignStatus;
  pauseReason: PauseReason | null;
  /** Running but outside the calling window → when it opens next. */
  waitingUntil: Date | null;
  stats: CampaignStats;
  estimate: CampaignEstimate | null;
  snapshot: { cursor: string | null; done: boolean; counts: Record<string, number> };
  parentId: Types.ObjectId | null;
  runNumber: number | null;
  /** Recurring parent: the next occurrence (claimed with compare-and-set by the job / sweep). */
  nextRunAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  canceledAt: Date | null;
  pausedAt: Date | null;
  startedBy: Types.ObjectId | null;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  revision: number;
  error: { code: string } | null;
  history: CampaignHistoryEntry[];
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const zeroes = (keys: readonly string[]): Record<string, number> =>
  Object.fromEntries(keys.map((k) => [k, 0]));

export const emptyCampaignStats = (): CampaignStats => ({
  total: 0,
  pending: 0,
  queued: 0,
  calling: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  canceled: 0,
  answered: 0,
  attempts: 0,
  dispositions: zeroes(DISPOSITIONS),
  skippedBy: zeroes(SKIP_REASONS),
  spentMicros: 0,
  virtualCostMicros: 0,
  failureStreak: 0,
});

/** Default dry-run behaviour (PHASE_8_PLAN §1b, PHASE_8_PROMPT §1). */
export const defaultDryRun = (): CampaignDryRun => ({
  mix: { answered: 6500, no_answer: 2000, busy: 1000, failed: 300, invalid_number: 200 },
  scenarios: {
    paid: 30,
    promise: 25,
    refuse: 10,
    callback: 10,
    silence: 10,
    wrong_number: 5,
    hangup_early: 5,
    wrong_keys: 5,
  },
  speed: CAMPAIGN_LIMITS.defaults.dryRunSpeed,
});

const windowSchema = new Schema<CampaignWindow>(
  {
    start: { type: String, required: true },
    end: { type: String, required: true },
    days: { type: [Number], default: [] },
  },
  { _id: false },
);

const schema = new Schema<CampaignDoc>(
  {
    name: { type: String, required: true, trim: true, maxlength: CAMPAIGN_LIMITS.nameMaxChars },
    mode: { type: String, enum: CAMPAIGN_MODES, default: 'dry_run' },
    flowId: { type: Schema.Types.ObjectId, default: null },
    line: { type: String, enum: CAMPAIGN_LINES, default: 'phone' },
    voiceApi: { type: Schema.Types.Mixed, default: null },
    channelId: { type: Schema.Types.ObjectId, default: null },
    program: { type: Schema.Types.Mixed, default: null },
    talkMode: { type: String, enum: TALK_MODES, default: 'ai' },
    team: { type: Schema.Types.Mixed, default: null },
    askPermissionFirst: { type: Schema.Types.Mixed, default: null },
    flowVersionId: { type: Schema.Types.ObjectId, default: null },
    flowVersion: { type: Number, default: null },
    chosenVersion: { type: Number, default: null },
    versionPolicy: { type: String, enum: VERSION_POLICIES, default: 'pinned' },
    audience: {
      listIds: { type: [Schema.Types.ObjectId], default: [] },
      segmentId: { type: Schema.Types.ObjectId, default: null },
      filter: { type: Schema.Types.Mixed, default: null },
      contactIds: { type: [Schema.Types.ObjectId], default: [] },
      excludeActiveCampaigns: { type: Boolean, default: true },
      skipIfMissing: { type: [String], default: [] },
    },
    schedule: {
      startAt: { type: Date, default: null },
      endAt: { type: Date, default: null },
      timezone: { type: String, required: true },
      recurrence: { type: Schema.Types.Mixed, default: null },
    },
    window: { type: windowSchema, required: true },
    retry: {
      maxAttempts: { type: Number, required: true },
      intervalMinutes: { type: Number, required: true },
      retryOn: { type: [{ type: String, enum: RETRY_ON }], default: [] },
    },
    followUps: {
      callbacks: { type: Boolean, default: true },
      callbackMaxDays: { type: Number, default: CAMPAIGN_LIMITS.defaults.callbackMaxDays },
      promiseCheck: {
        enabled: { type: Boolean, default: false },
        daysAfter: { type: Number, default: 1 },
      },
    },
    pacing: {
      concurrency: { type: Number, required: true },
      dialsPerMinute: { type: Number, required: true },
      priority: { type: String, enum: CAMPAIGN_PRIORITIES, default: 'normal' },
    },
    autoResume: { type: Boolean, default: true },
    phoneLine: { type: Schema.Types.Mixed, default: () => defaultPhoneLine() },
    dryRun: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: CAMPAIGN_STATUSES, default: 'draft' },
    pauseReason: { type: String, enum: [...PAUSE_REASONS, null], default: null },
    waitingUntil: { type: Date, default: null },
    stats: { type: Schema.Types.Mixed, default: emptyCampaignStats },
    estimate: { type: Schema.Types.Mixed, default: null },
    snapshot: {
      cursor: { type: String, default: null },
      done: { type: Boolean, default: false },
      counts: { type: Schema.Types.Mixed, default: () => ({}) },
    },
    parentId: { type: Schema.Types.ObjectId, default: null },
    runNumber: { type: Number, default: null },
    nextRunAt: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    pausedAt: { type: Date, default: null },
    startedBy: { type: Schema.Types.ObjectId, default: null },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
    revision: { type: Number, default: 1, min: 1 },
    error: { type: Schema.Types.Mixed, default: null },
    history: {
      type: [
        new Schema<CampaignHistoryEntry>(
          {
            at: { type: Date, required: true },
            status: { type: String, enum: CAMPAIGN_STATUSES, required: true },
            pauseReason: { type: String, enum: [...PAUSE_REASONS, null], default: null },
            by: { type: Schema.Types.ObjectId, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  // keep empty objects (`counts: {}`, `dispositions` with zeroes)
  { minimize: false },
);
schema.plugin(basePlugin, { hide: ['deletedAt'] });
schema.plugin(tenantPlugin);
schema.plugin(softDeletePlugin);
schema.index(
  { accountId: 1, name: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    collation: { locale: 'en', strength: 2 },
  },
);
schema.index({ accountId: 1, status: 1, createdAt: -1 });
schema.index({ status: 1, 'schedule.startAt': 1 });
schema.index({ accountId: 1, flowId: 1, status: 1 });
schema.index({ accountId: 1, line: 1, status: 1 }, { name: 'campaign_line_status' });
schema.index({ parentId: 1, runNumber: -1 });

/** Campaigns (data-model.md §2.5 — Phase 8). */
export const CampaignModel: Model<CampaignDoc> =
  (mongoose.models.Campaign as Model<CampaignDoc> | undefined) ??
  mongoose.model<CampaignDoc>('Campaign', schema, 'campaigns');
