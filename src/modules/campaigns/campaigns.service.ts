import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { getEnv } from '../../config/env';
import { CAMPAIGN_LIMITS } from '../../config/limits';
import { availableMicros } from '../../core/billing/events';
import { getOrCreateWallet } from '../../core/billing/wallets';
import { FlowGraphSchema, parseNodeConfig } from '../../core/engine/schema';
import { notifyAccount } from '../../core/realtime/notify';
import { isDuplicateKeyError } from '../../db/errors';
import {
  AccountModel,
  DEFAULT_ACCOUNT_LIMITS,
  DEFAULT_ACCOUNT_SETTINGS,
  type AccountLimits,
  type CallCaps,
  type CallingWindow,
} from '../../db/models/account.model';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { CampaignContactModel, CLAIMABLE_STATUSES } from '../../db/models/campaign-contact.model';
import {
  ACTIVE_CAMPAIGN_STATUSES,
  CampaignModel,
  defaultDryRun,
  emptyCampaignStats,
  type CampaignAudience,
  type CampaignDoc,
  type CampaignStatus,
  type PauseReason,
} from '../../db/models/campaign.model';
import { ContactListModel } from '../../db/models/contact-list.model';
import { ContactModel } from '../../db/models/contact.model';
import { FlowAudioModel } from '../../db/models/flow-audio.model';
import { FlowVersionModel, type FlowVersionDoc } from '../../db/models/flow-version.model';
import { FlowModel, type FlowDoc } from '../../db/models/flow.model';
import { SegmentModel } from '../../db/models/segment.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
  type ErrorDetail,
} from '../../shared/errors/app-error';
import { decodeCursor, encodeCursor } from '../../shared/http/cursor';
import type { Logger } from '../../shared/logger';
import { escapeRegex } from '../../shared/utils/regex';
import { accountVariables } from '../ai-agents/variables';
import { auditRequest } from '../audit/audit.service';

import { audienceQuery, previewAudience, toAudience, usedFields } from './audience';
import { loadNames, toCampaignListItem, toCampaignView, toContactRow } from './campaign-json';
import type {
  AudiencePreviewBody,
  CreateCampaignBody,
  ListCampaignContactsQuery,
  ListCampaignsQuery,
  UpdateCampaignBody,
} from './campaigns.schema';
import { estimateCost } from './estimate';
import { canMoveCampaign, DELETABLE, editRule, LIVE_EDITABLE } from './lifecycle';
import { notifyCampaignStatus } from './notifications';
import { firstRunAt } from './recurrence';
import { takeSnapshot } from './snapshot';
import { intersect } from './window';

// ── hooks (wired by the scheduler / dispatcher, T8.5) ─────────────────────────

/** What the scheduler does when a campaign changes state; no-ops until wired. */
export interface CampaignHooks {
  /** A campaign waits for `schedule.startAt` (delayed start job). */
  scheduled(campaign: CampaignDoc): Promise<void>;
  /** A scheduled campaign went back to draft / was canceled (drop its jobs). */
  unscheduled(campaign: CampaignDoc): Promise<void>;
  /** A campaign is running (again): wake the account's dispatcher. */
  running(campaign: CampaignDoc): Promise<void>;
  /** Hang up the campaign's live calls (cancel with `hangUpLive`). */
  hangUpLive(campaign: CampaignDoc): Promise<void>;
  /** Why a paused campaign can't resume yet (wallet / budget), or `null`. */
  resumeBlocker(campaign: CampaignDoc): Promise<string | null>;
}

const noHooks: CampaignHooks = {
  scheduled: () => Promise.resolve(),
  unscheduled: () => Promise.resolve(),
  running: () => Promise.resolve(),
  hangUpLive: () => Promise.resolve(),
  resumeBlocker: () => Promise.resolve(null),
};

let hooks: CampaignHooks = noHooks;

/** The scheduler registers its hooks (tests: a partial set; reset with `{}`). */
export const setCampaignHooks = (next: Partial<CampaignHooks>): void => {
  hooks = { ...noHooks, ...next };
};

// ── lookups ──────────────────────────────────────────────────────────────────

const campaignNotFound = () => new NotFoundError('Campaign not found');

export const findCampaign = async (accountId: Types.ObjectId, id: string): Promise<CampaignDoc> => {
  const _id = toObjectId(id);
  const campaign = _id ? await CampaignModel.findOne({ _id, accountId }).lean<CampaignDoc>() : null;
  if (!campaign) throw campaignNotFound();
  return campaign;
};

export interface AccountFacts {
  timezone: string;
  window: CallingWindow;
  limits: AccountLimits;
  caps: CallCaps;
  status: 'active' | 'suspended';
}

export const accountFacts = async (accountId: Types.ObjectId): Promise<AccountFacts> => {
  const account = await AccountModel.findById(accountId)
    .select({ timezone: 1, settings: 1, limits: 1, status: 1 })
    .lean<{
      timezone?: string;
      status?: 'active' | 'suspended';
      settings?: { callingWindow?: CallingWindow; callCaps?: Partial<CallCaps> };
      limits?: Partial<AccountLimits>;
    }>();
  return {
    timezone: account?.timezone ?? 'Asia/Kolkata',
    window: account?.settings?.callingWindow ?? DEFAULT_ACCOUNT_SETTINGS.callingWindow,
    limits: { ...DEFAULT_ACCOUNT_LIMITS, ...account?.limits },
    caps: { ...DEFAULT_ACCOUNT_SETTINGS.callCaps, ...account?.settings?.callCaps },
    status: account?.status ?? 'active',
  };
};

export interface PinnedVersion {
  flow: FlowDoc;
  version: FlowVersionDoc;
  graph: unknown;
  hasAi: boolean;
}

/**
 * The flow version a campaign uses: a chosen number or the latest published;
 * the version's start step must allow the `campaign` trigger.
 */
export const loadFlowVersion = async (
  accountId: Types.ObjectId,
  flowId: Types.ObjectId | string,
  chosenVersion: number | null,
): Promise<PinnedVersion> => {
  const _id = toObjectId(String(flowId));
  const flow = _id ? await FlowModel.findOne({ _id, accountId }).lean<FlowDoc>() : null;
  if (!flow) throw new ValidationError([{ path: 'flowId', message: 'Flow not found' }]);
  const number = chosenVersion ?? flow.publishedVersion;
  if (!number) {
    throw new ValidationError([
      { path: 'flowId', message: 'Publish this flow before using it in a campaign' },
    ]);
  }
  const version = await FlowVersionModel.findOne({
    accountId,
    flowId: flow._id,
    version: number,
  }).lean<FlowVersionDoc>();
  if (!version)
    throw new ValidationError([{ path: 'chosenVersion', message: 'Version not found' }]);
  const parsed = FlowGraphSchema.safeParse(version.graph);
  const graph = parsed.success ? parsed.data : version.graph;
  const nodes = (graph as { nodes?: { type: string; config?: unknown }[] }).nodes ?? [];
  const start = nodes.find((n) => n.type === 'start');
  // stored versions may omit defaults (templates): parse the start step like the engine does
  const startConfig = start ? parseNodeConfig('start', start.config ?? {}) : null;
  if (!startConfig?.ok || !startConfig.config.triggers.includes('campaign')) {
    throw new ValidationError([
      { path: 'flowId', message: "This flow's start step does not allow campaigns" },
    ]);
  }
  return { flow, version, graph, hasAi: nodes.some((n) => n.type === 'ai_agent') };
};

/** Problems that stop a pinned version from running (agents off / gone, audio gone). */
export const runnableProblems = async (pinned: PinnedVersion): Promise<ErrorDetail[]> => {
  const { version } = pinned;
  const problems: ErrorDetail[] = [];
  if (version.agentIds.length) {
    const agents = await AiAgentModel.find({
      _id: { $in: version.agentIds },
      accountId: version.accountId,
    })
      .select({ name: 1, isActive: 1 })
      .lean<{ _id: Types.ObjectId; name: string; isActive: boolean }[]>();
    for (const id of version.agentIds) {
      const agent = agents.find((a) => a._id.equals(id));
      if (!agent)
        problems.push({ path: 'flow.agents', message: 'An AI agent of this flow was deleted' });
      else if (!agent.isActive) {
        problems.push({ path: 'flow.agents', message: `AI agent "${agent.name}" is turned off` });
      }
    }
  }
  if (version.audioIds.length) {
    const found = await FlowAudioModel.countDocuments({
      _id: { $in: version.audioIds },
      accountId: version.accountId,
    });
    if (found < version.audioIds.length) {
      problems.push({ path: 'flow.audio', message: 'An audio file of this flow was deleted' });
    }
  }
  return problems;
};

const notRunnable = (details: ErrorDetail[], message = 'This campaign cannot be started.') =>
  new ConflictError('CAMPAIGN_NOT_RUNNABLE', message, details);

const liveRefused = () =>
  notRunnable(
    [
      {
        path: 'mode',
        message: 'Phone calls need a phone line (SIP) — available with phone numbers',
      },
    ],
    'Live campaigns need a phone line.',
  );

// ── settings ─────────────────────────────────────────────────────────────────

type SettingsInput = Omit<z.infer<typeof UpdateCampaignBody>, 'revision'>;

type CampaignSettings = Pick<
  CampaignDoc,
  | 'name'
  | 'mode'
  | 'flowId'
  | 'chosenVersion'
  | 'versionPolicy'
  | 'audience'
  | 'schedule'
  | 'window'
  | 'retry'
  | 'followUps'
  | 'pacing'
  | 'autoResume'
  | 'dryRun'
>;

/** New-campaign defaults (PHASE_8_PROMPT §1 "Limits"), bounded by the account limits. */
export const defaultSettings = (
  account: AccountFacts,
  base: { name: string; flowId: Types.ObjectId; mode: CampaignDoc['mode'] },
): CampaignSettings => ({
  name: base.name,
  mode: base.mode,
  flowId: base.flowId,
  chosenVersion: null,
  versionPolicy: 'pinned',
  audience: {
    listIds: [],
    segmentId: null,
    filter: null,
    contactIds: [],
    excludeActiveCampaigns: true,
    skipIfMissing: [],
  },
  schedule: { startAt: null, endAt: null, timezone: account.timezone, recurrence: null },
  window: { ...account.window, days: [...account.window.days] },
  retry: {
    maxAttempts: CAMPAIGN_LIMITS.defaults.maxAttempts,
    intervalMinutes: CAMPAIGN_LIMITS.defaults.intervalMinutes,
    retryOn: [...CAMPAIGN_LIMITS.defaults.retryOn],
  },
  followUps: {
    callbacks: true,
    callbackMaxDays: CAMPAIGN_LIMITS.defaults.callbackMaxDays,
    promiseCheck: { enabled: false, daysAfter: CAMPAIGN_LIMITS.defaults.promiseDaysAfter },
  },
  pacing: {
    concurrency: Math.min(CAMPAIGN_LIMITS.defaults.concurrency, account.limits.maxConcurrentCalls),
    dialsPerMinute: Math.min(
      CAMPAIGN_LIMITS.defaults.dialsPerMinute,
      account.limits.dialsPerMinute,
    ),
    priority: CAMPAIGN_LIMITS.defaults.priority,
  },
  autoResume: true,
  dryRun: base.mode === 'dry_run' ? defaultDryRun() : null,
});

const date = (v: string | null | undefined, fallback: Date | null): Date | null =>
  v === undefined ? fallback : v === null ? null : new Date(v);

/** Input groups merged into the current settings (only the fields sent change). */
export const mergeSettings = (
  current: CampaignSettings,
  input: SettingsInput,
): CampaignSettings => {
  const mode = input.mode ?? current.mode;
  const dryRunBase = current.dryRun ?? defaultDryRun();
  return {
    name: input.name ?? current.name,
    mode,
    flowId: input.flowId ? new Types.ObjectId(input.flowId) : current.flowId,
    chosenVersion: input.chosenVersion === undefined ? current.chosenVersion : input.chosenVersion,
    versionPolicy: input.versionPolicy ?? current.versionPolicy,
    audience: input.audience ? toAudience(input.audience, current.audience) : current.audience,
    schedule: input.schedule
      ? {
          startAt: date(input.schedule.startAt, current.schedule.startAt),
          endAt: date(input.schedule.endAt, current.schedule.endAt),
          timezone: input.schedule.timezone ?? current.schedule.timezone,
          recurrence:
            input.schedule.recurrence === undefined
              ? current.schedule.recurrence
              : input.schedule.recurrence
                ? {
                    freq: input.schedule.recurrence.freq,
                    days: [...new Set(input.schedule.recurrence.days)].sort((a, b) => a - b),
                    time: input.schedule.recurrence.time,
                    until: date(input.schedule.recurrence.until, null),
                  }
                : null,
        }
      : current.schedule,
    window: input.window ?? current.window,
    retry: { ...current.retry, ...input.retry },
    followUps: {
      ...current.followUps,
      ...input.followUps,
      promiseCheck: { ...current.followUps.promiseCheck, ...input.followUps?.promiseCheck },
    },
    pacing: { ...current.pacing, ...input.pacing },
    autoResume: input.autoResume ?? current.autoResume,
    dryRun:
      mode !== 'dry_run'
        ? null
        : input.dryRun === null
          ? defaultDryRun()
          : input.dryRun === undefined
            ? dryRunBase
            : { ...dryRunBase, ...input.dryRun },
  };
};

/**
 * Combination rules on the merged settings (field errors → 422; a live mode
 * → 409 `CAMPAIGN_NOT_RUNNABLE` until a phone line exists).
 */
export const validateSettings = async (
  accountId: Types.ObjectId,
  s: CampaignSettings,
  account: AccountFacts,
  now: Date,
): Promise<void> => {
  if (s.mode === 'live') throw liveRefused();
  const details: ErrorDetail[] = [];
  if (!intersect(s.window, account.window)) {
    details.push({
      path: 'window',
      message: 'Outside the account calling window (Settings → Calls)',
    });
  }
  if (new Set(s.retry.retryOn).size !== s.retry.retryOn.length) {
    details.push({ path: 'retry.retryOn', message: 'Each result once' });
  }
  if (s.pacing.concurrency > account.limits.maxConcurrentCalls) {
    details.push({
      path: 'pacing.concurrency',
      message: `At most ${String(account.limits.maxConcurrentCalls)} (account limit)`,
    });
  }
  if (s.pacing.dialsPerMinute > account.limits.dialsPerMinute) {
    details.push({
      path: 'pacing.dialsPerMinute',
      message: `At most ${String(account.limits.dialsPerMinute)} (account limit)`,
    });
  }
  const { startAt, endAt, recurrence } = s.schedule;
  const latest = now.getTime() + CAMPAIGN_LIMITS.scheduleAheadDays * 86_400_000;
  if (startAt && startAt.getTime() > latest) {
    details.push({
      path: 'schedule.startAt',
      message: `At most ${String(CAMPAIGN_LIMITS.scheduleAheadDays)} days ahead`,
    });
  }
  if (endAt && endAt.getTime() <= Math.max(startAt?.getTime() ?? 0, now.getTime())) {
    details.push({ path: 'schedule.endAt', message: 'Must be after the start' });
  }
  if (recurrence?.freq === 'weekly' && recurrence.days.length === 0) {
    details.push({ path: 'schedule.recurrence.days', message: 'Pick at least one day' });
  }
  if (recurrence?.until && recurrence.until.getTime() <= now.getTime()) {
    details.push({ path: 'schedule.recurrence.until', message: 'Must be in the future' });
  }
  if (s.dryRun) {
    const sum = Object.values(s.dryRun.mix).reduce((a, b) => a + b, 0);
    if (sum !== 10_000) details.push({ path: 'dryRun.mix', message: 'Must add up to 100 %' });
    const max = getEnv().DRY_RUN_MAX_SPEED;
    if (s.dryRun.speed > max) {
      details.push({ path: 'dryRun.speed', message: `At most ×${String(max)}` });
    }
  }
  if (s.audience.skipIfMissing.length) {
    const names = new Set((await accountVariables(accountId)).map((v) => v.name));
    if (s.audience.skipIfMissing.some((f) => !names.has(f))) {
      details.push({ path: 'audience.skipIfMissing', message: 'Unknown contact field' });
    }
  }
  details.push(...(await audienceRefProblems(accountId, s.audience)));
  if (details.length) throw new ValidationError(details);
};

/** Lists, segment and picked contacts must belong to the account. */
const audienceRefProblems = async (
  accountId: Types.ObjectId,
  audience: CampaignAudience,
): Promise<ErrorDetail[]> => {
  const problems: ErrorDetail[] = [];
  if (audience.listIds.length) {
    const n = await ContactListModel.countDocuments({ _id: { $in: audience.listIds }, accountId });
    if (n < new Set(audience.listIds.map(String)).size) {
      problems.push({ path: 'audience.listIds', message: 'List not found' });
    }
  }
  if (audience.segmentId && !(await SegmentModel.exists({ _id: audience.segmentId, accountId }))) {
    problems.push({ path: 'audience.segmentId', message: 'Segment not found' });
  }
  if (audience.contactIds.length) {
    const n = await ContactModel.countDocuments({ _id: { $in: audience.contactIds }, accountId });
    if (n < new Set(audience.contactIds.map(String)).size) {
      problems.push({ path: 'audience.contactIds', message: 'Contact not found' });
    }
  }
  return problems;
};

const NAME_COLLATION = { locale: 'en', strength: 2 } as const;

const duplicateName = () =>
  new ConflictError('CONFLICT_DUPLICATE', 'A campaign with this name already exists.', [
    { path: 'name', message: 'Already exists' },
  ]);

export const nameTaken = async (
  accountId: Types.ObjectId,
  name: string,
  exceptId?: Types.ObjectId,
) =>
  Boolean(
    await CampaignModel.findOne({
      accountId,
      name,
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    })
      .collation(NAME_COLLATION)
      .select({ _id: 1 })
      .lean(),
  );

const freeName = async (accountId: Types.ObjectId, base: string): Promise<string> => {
  const fit = (end: string) => `${base.slice(0, CAMPAIGN_LIMITS.nameMaxChars - end.length)}${end}`;
  if (!(await nameTaken(accountId, fit(' (copy)')))) return fit(' (copy)');
  for (let n = 2; ; n += 1) {
    const name = fit(` (copy ${String(n)})`);
    if (!(await nameTaken(accountId, name))) return name;
  }
};

const userOf = (req: Request): Types.ObjectId | null => {
  const id = requireAuth(req).userId;
  return id ? new Types.ObjectId(id) : null;
};

const walletAvailable = async (accountId: Types.ObjectId) =>
  availableMicros(await getOrCreateWallet(accountId));

const view = async (campaign: CampaignDoc) =>
  toCampaignView(
    campaign,
    await loadNames(campaign.accountId, [campaign]),
    await walletAvailable(campaign.accountId),
  );

const target = (c: CampaignDoc) => ({ type: 'campaign', id: c._id.toString() });

// ── CRUD ─────────────────────────────────────────────────────────────────────

export const createCampaign = async (req: Request, body: z.infer<typeof CreateCampaignBody>) => {
  const { accountId } = tenantFilter(req);
  const account = await accountFacts(accountId);
  const settings = mergeSettings(
    defaultSettings(account, {
      name: body.name,
      flowId: new Types.ObjectId(body.flowId),
      mode: body.mode,
    }),
    body,
  );
  await validateSettings(accountId, settings, account, new Date());
  await loadFlowVersion(accountId, settings.flowId, settings.chosenVersion);
  if (await nameTaken(accountId, settings.name)) throw duplicateName();
  const by = userOf(req);
  let campaign: CampaignDoc;
  try {
    campaign = (
      await CampaignModel.create({
        accountId,
        ...settings,
        status: 'draft',
        stats: emptyCampaignStats(),
        createdBy: by,
        updatedBy: by,
        history: [{ at: new Date(), status: 'draft', pauseReason: null, by }],
      })
    ).toObject({ transform: false });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
  await auditRequest(req, 'campaign.created', {
    target: target(campaign),
    meta: { mode: campaign.mode, flowId: campaign.flowId.toString() },
  });
  return view(campaign);
};

export const getCampaign = async (req: Request, id: string) =>
  view(await findCampaign(tenantFilter(req).accountId, id));

export const listCampaigns = async (req: Request, query: z.infer<typeof ListCampaignsQuery>) => {
  const { accountId } = tenantFilter(req);
  const filter: Record<string, unknown> = { accountId };
  if (query.status) filter.status = { $in: query.status };
  if (query.mode) filter.mode = query.mode;
  if (query.flowId) filter.flowId = new Types.ObjectId(query.flowId);
  if (query.parentId) filter.parentId = new Types.ObjectId(query.parentId);
  if (query.q) filter.name = { $regex: escapeRegex(query.q), $options: 'i' };
  if (query.contactId) {
    const ids = await CampaignContactModel.distinct('campaignId', {
      accountId,
      contactId: new Types.ObjectId(query.contactId),
    });
    filter._id = { $in: ids };
  }
  if (query.cursor) {
    const c = decodeCursor(query.cursor);
    const at = new Date(c.at);
    filter.$or = [
      { createdAt: { $lt: at } },
      { createdAt: at, _id: { $lt: new Types.ObjectId(c.id) } },
    ];
  }
  const rows = await CampaignModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(query.limit + 1)
    .lean<CampaignDoc[]>();
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const names = await loadNames(accountId, page);
  const last = page.at(-1);
  return {
    items: page.map((c) => toCampaignListItem(c, names)),
    meta: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last._id.toString() })
          : null,
    },
  };
};

/** Fields a started campaign may not change (PHASE_8_PLAN §1e). */
const lockedWhenLive = (input: SettingsInput): string[] => {
  const locked: string[] = [];
  for (const key of Object.keys(input) as (keyof SettingsInput)[]) {
    if (input[key] === undefined) continue;
    if (key === 'schedule') {
      const { endAt, ...rest } = input.schedule ?? {};
      void endAt;
      if (Object.values(rest).some((v) => v !== undefined)) locked.push('schedule');
    } else if (!(LIVE_EDITABLE as readonly string[]).includes(key)) locked.push(key);
  }
  return locked;
};

export const updateCampaign = async (
  req: Request,
  id: string,
  body: z.infer<typeof UpdateCampaignBody>,
) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  const { revision, ...input } = body;
  const rule = editRule(campaign.status);
  if (rule === 'none') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `A ${campaign.status} campaign can't be edited.`,
    );
  }
  if (rule === 'not_mode' && input.mode !== undefined && input.mode !== campaign.mode) {
    throw new ValidationError([{ path: 'mode', message: "Can't change once scheduled" }]);
  }
  if (rule === 'live') {
    const locked = lockedWhenLive(input);
    if (locked.length) {
      throw new ValidationError(
        locked.map((path) => ({ path, message: "Can't change once the campaign started" })),
      );
    }
  }
  const account = await accountFacts(accountId);
  const settings = mergeSettings(campaign, input);
  await validateSettings(accountId, settings, account, new Date());
  if (input.flowId !== undefined || input.chosenVersion !== undefined) {
    await loadFlowVersion(accountId, settings.flowId, settings.chosenVersion);
  }
  if (input.name !== undefined && (await nameTaken(accountId, settings.name, campaign._id))) {
    throw duplicateName();
  }
  let updated: CampaignDoc | null;
  try {
    updated = await CampaignModel.findOneAndUpdate(
      { _id: campaign._id, accountId, revision },
      { $set: { ...settings, updatedBy: userOf(req) }, $inc: { revision: 1 } },
      { returnDocument: 'after' },
    ).lean<CampaignDoc>();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
  if (!updated) {
    throw new ConflictError('CAMPAIGN_REVISION_CONFLICT', undefined, [
      { path: 'revision', message: String(campaign.revision) },
    ]);
  }
  await auditRequest(req, 'campaign.updated', {
    target: target(updated),
    meta: {
      fields: Object.keys(input).filter((k) => input[k as keyof SettingsInput] !== undefined),
    },
  });
  // a new start time moves the delayed start job
  if (updated.status === 'scheduled' && input.schedule !== undefined)
    await hooks.scheduled(updated);
  notifyAccount(accountId.toString(), 'campaign.status', {
    campaignId: updated._id.toString(),
    status: updated.status,
  });
  return view(updated);
};

export const duplicateCampaign = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const source = await findCampaign(accountId, id);
  const by = userOf(req);
  const name = await freeName(accountId, source.name);
  const copy = (
    await CampaignModel.create({
      accountId,
      name,
      mode: source.mode,
      flowId: source.flowId,
      chosenVersion: source.chosenVersion,
      versionPolicy: source.versionPolicy,
      audience: source.audience,
      schedule: { ...source.schedule, startAt: null },
      window: source.window,
      retry: source.retry,
      followUps: source.followUps,
      pacing: source.pacing,
      autoResume: source.autoResume,
      dryRun: source.dryRun,
      status: 'draft',
      stats: emptyCampaignStats(),
      createdBy: by,
      updatedBy: by,
      history: [{ at: new Date(), status: 'draft', pauseReason: null, by }],
    })
  ).toObject({ transform: false });
  await auditRequest(req, 'campaign.created', {
    target: target(copy),
    meta: { mode: copy.mode, flowId: copy.flowId.toString(), source: 'duplicate' },
  });
  return view(copy);
};

/** Runs of a recurring campaign, newest first (`GET /campaigns/:id/runs`). */
export const listCampaignRuns = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const parent = await findCampaign(accountId, id);
  const runs = await CampaignModel.find({ accountId, parentId: parent._id })
    .sort({ runNumber: -1 })
    .limit(CAMPAIGN_LIMITS.runsListMax)
    .lean<CampaignDoc[]>();
  const names = await loadNames(accountId, runs);
  return { items: runs.map((c) => toCampaignListItem(c, names)) };
};

export const deleteCampaign = async (req: Request, id: string): Promise<void> => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  if (!DELETABLE.includes(campaign.status)) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'Cancel the campaign before deleting it.');
  }
  await CampaignModel.updateOne(
    { _id: campaign._id, accountId },
    { $set: { deletedAt: new Date() } },
  );
  await auditRequest(req, 'campaign.deleted', { target: target(campaign) });
};

export const listCampaignContacts = async (
  req: Request,
  id: string,
  query: z.infer<typeof ListCampaignContactsQuery>,
) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  const filter: Record<string, unknown> = { accountId, campaignId: campaign._id };
  if (query.status) filter.status = { $in: query.status };
  if (query.lastResult) filter.lastResult = query.lastResult;
  if (query.disposition) filter.disposition = query.disposition;
  if (query.skipReason) filter.skipReason = query.skipReason;
  if (query.q) filter.name = { $regex: escapeRegex(query.q), $options: 'i' };
  if (query.cursor) {
    const after = await CampaignContactModel.findOne({
      _id: new Types.ObjectId(decodeCursor(query.cursor).id),
      campaignId: campaign._id,
    })
      .select({ seq: 1 })
      .lean<{ seq: number }>();
    filter.seq = { $gt: after?.seq ?? Number.MAX_SAFE_INTEGER };
  }
  const rows = await CampaignContactModel.find(filter)
    .sort({ seq: 1 })
    .limit(query.limit + 1)
    .lean();
  const hasMore = rows.length > query.limit;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toContactRow),
    meta: {
      limit: query.limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? encodeCursor({ at: last.createdAt.toISOString(), id: last._id.toString() })
          : null,
    },
  };
};

// ── preview / estimate ───────────────────────────────────────────────────────

export const previewCampaignAudience = async (
  req: Request,
  body: z.infer<typeof AudiencePreviewBody>,
) => {
  const { accountId } = tenantFilter(req);
  const pinned = await loadFlowVersion(accountId, body.flowId, body.chosenVersion ?? null);
  const audience = toAudience(body.audience, {
    listIds: [],
    segmentId: null,
    filter: null,
    contactIds: [],
    excludeActiveCampaigns: true,
    skipIfMissing: [],
  });
  const problems = await audienceRefProblems(accountId, audience);
  if (problems.length) throw new ValidationError(problems);
  const used = await usedFields(accountId, pinned.graph, pinned.version.agentIds);
  return previewAudience({ accountId, audience, used });
};

export const estimateCampaignCost = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  const pinned = await loadFlowVersion(accountId, campaign.flowId, campaign.chosenVersion);
  const used = await usedFields(accountId, pinned.graph, pinned.version.agentIds);
  const contacts = campaign.snapshot.done
    ? campaign.stats.total - campaign.stats.skipped
    : (
        await previewAudience({
          accountId,
          audience: campaign.audience,
          used,
          campaignId: campaign._id,
        })
      ).willCall;
  const estimate = await estimateCost({
    accountId,
    flowId: campaign.flowId,
    contacts,
    retry: campaign.retry,
    hasAi: pinned.hasAi,
  });
  await CampaignModel.updateOne(
    { _id: campaign._id },
    {
      $set: {
        estimate: {
          contacts: estimate.contacts,
          calls: estimate.calls,
          perCallMicros: estimate.perCallMicros,
          totalMicros: estimate.totalMicros,
          minMicros: estimate.minMicros,
          maxMicros: estimate.maxMicros,
          at: new Date(),
        },
      },
    },
  );
  return { ...estimate, walletAvailableMicros: await walletAvailable(accountId) };
};

// ── lifecycle ────────────────────────────────────────────────────────────────

export interface StatusChange {
  pauseReason?: PauseReason | null;
  by?: Types.ObjectId | null;
  set?: Record<string, unknown>;
}

/**
 * Moves a campaign to `to` if it is still in its current status (compare and
 * set), records history (last 100) and tells the account. Refused moves → 409.
 */
export const setStatus = async (
  campaign: CampaignDoc,
  to: CampaignStatus,
  change: StatusChange = {},
): Promise<CampaignDoc> => {
  if (!canMoveCampaign(campaign.status, to)) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `A ${campaign.status} campaign can't become ${to}.`,
    );
  }
  const pauseReason = to === 'paused' ? (change.pauseReason ?? 'manual') : null;
  const at = new Date();
  const updated = await CampaignModel.findOneAndUpdate(
    { _id: campaign._id, status: campaign.status },
    {
      $set: {
        status: to,
        pauseReason,
        ...(to === 'paused' ? { pausedAt: at } : {}),
        ...(to !== 'running' ? { waitingUntil: null } : {}),
        ...change.set,
      },
      $push: {
        history: {
          $each: [{ at, status: to, pauseReason, by: change.by ?? null }],
          $slice: -CAMPAIGN_LIMITS.historyMax,
        },
      },
    },
    { returnDocument: 'after' },
  ).lean<CampaignDoc>();
  if (!updated) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'The campaign changed meanwhile — reload it.',
    );
  }
  notifyAccount(campaign.accountId.toString(), 'campaign.status', {
    campaignId: campaign._id.toString(),
    status: to,
    ...(pauseReason ? { pauseReason } : {}),
  });
  if (to === 'paused' || to === 'completed') await notifyCampaignStatus(updated, change.by ?? null);
  return updated;
};

/**
 * Starts dialing now (also the scheduled start job): pins the version, takes
 * the snapshot, `running` — or `completed` when nobody is left to call.
 */
export const beginRun = async (
  campaign: CampaignDoc,
  by: Types.ObjectId | null,
): Promise<CampaignDoc> => {
  const pinned = await loadFlowVersion(campaign.accountId, campaign.flowId, campaign.chosenVersion);
  const problems = await runnableProblems(pinned);
  if (problems.length) throw notRunnable(problems);
  const now = new Date();
  const running = await setStatus(campaign, 'running', {
    by,
    set: {
      flowVersionId: pinned.version._id,
      flowVersion: pinned.version.version,
      startedAt: campaign.startedAt ?? now,
      startedBy: campaign.startedBy ?? by,
    },
  });
  const used = await usedFields(campaign.accountId, pinned.graph, pinned.version.agentIds);
  const counts = await takeSnapshot(running, used, now);
  const fresh = (await CampaignModel.findById(campaign._id).lean<CampaignDoc>()) as CampaignDoc;
  if (counts.byStat.pending === 0) {
    return setStatus(fresh, 'completed', { by, set: { completedAt: new Date() } });
  }
  await hooks.running(fresh);
  return fresh;
};

/**
 * Why the campaign's pinned version can't run now (agents switched off, audio
 * gone, flow / version not loadable) — empty when it can.
 */
export const pinnedProblems = async (campaign: CampaignDoc): Promise<ErrorDetail[]> => {
  try {
    const pinned = await loadFlowVersion(
      campaign.accountId,
      campaign.flowId,
      campaign.flowVersion ?? campaign.chosenVersion,
    );
    return await runnableProblems(pinned);
  } catch (err) {
    if (!isNotRunnableError(err)) throw err;
    return err.details?.length ? err.details : [{ path: 'flowId', message: err.message }];
  }
};

/** Start now, or schedule (a start time in the future, or a recurring parent). */
export const startCampaign = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  if (campaign.status !== 'draft') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `A ${campaign.status} campaign can't be started.`,
    );
  }
  if (campaign.mode === 'live') throw liveRefused();
  const account = await accountFacts(accountId);
  if (account.status === 'suspended') {
    throw notRunnable([{ path: 'account', message: 'The account is suspended' }]);
  }
  await validateSettings(accountId, campaign, account, new Date());
  if (!(await audienceQuery(accountId, campaign.audience))) {
    throw notRunnable([{ path: 'audience', message: 'Choose who to call' }]);
  }
  const pinned = await loadFlowVersion(accountId, campaign.flowId, campaign.chosenVersion);
  const problems = await runnableProblems(pinned);
  if (problems.length) throw notRunnable(problems);
  const active = await CampaignModel.countDocuments({
    accountId,
    _id: { $ne: campaign._id },
    status: { $in: ACTIVE_CAMPAIGN_STATUSES },
    parentId: null,
  });
  if (active >= CAMPAIGN_LIMITS.maxActivePerAccount) throw new AppError('CAMPAIGN_LIMIT_REACHED');
  const by = userOf(req);
  const later =
    campaign.schedule.recurrence !== null ||
    (campaign.schedule.startAt !== null && campaign.schedule.startAt.getTime() > Date.now());
  if (later) {
    const recurring = campaign.schedule.recurrence
      ? {
          // the parent pins its version now (runs use it with versionPolicy "pinned")
          flowVersionId: pinned.version._id,
          flowVersion: pinned.version.version,
          nextRunAt: firstRunAt(campaign.schedule, new Date()),
        }
      : {};
    const scheduled = await setStatus(campaign, 'scheduled', {
      by,
      set: { startedBy: by, ...recurring },
    });
    await hooks.scheduled(scheduled);
    await auditRequest(req, 'campaign.scheduled', {
      target: target(scheduled),
      meta: {
        startAt: scheduled.schedule.startAt?.toISOString() ?? null,
        recurring: scheduled.schedule.recurrence !== null,
      },
    });
    return view(scheduled);
  }
  const started = await beginRun(campaign, by);
  await auditRequest(req, 'campaign.started', {
    target: target(started),
    meta: { contacts: started.stats.total, flowVersion: started.flowVersion },
  });
  return view(started);
};

export const unscheduleCampaign = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  if (campaign.status !== 'scheduled') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Only a scheduled campaign can go back to draft.',
    );
  }
  const draft = await setStatus(campaign, 'draft', { by: userOf(req), set: { nextRunAt: null } });
  await hooks.unscheduled(draft);
  await auditRequest(req, 'campaign.updated', {
    target: target(draft),
    meta: { fields: ['status'] },
  });
  return view(draft);
};

/** Pauses a campaign (manual, or automatic with a reason). */
export const pauseCampaignDoc = async (
  campaign: CampaignDoc,
  reason: PauseReason,
  by: Types.ObjectId | null,
): Promise<CampaignDoc> => setStatus(campaign, 'paused', { pauseReason: reason, by });

export const pauseCampaign = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  if (campaign.status !== 'running' && campaign.status !== 'scheduled') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `A ${campaign.status} campaign can't be paused.`,
    );
  }
  const paused = await pauseCampaignDoc(campaign, 'manual', userOf(req));
  await auditRequest(req, 'campaign.paused', {
    target: target(paused),
    meta: { reason: 'manual' },
  });
  return view(paused);
};

/** Back to running (or scheduled when it never started); refused while the cause holds. */
export const resumeCampaignDoc = async (
  campaign: CampaignDoc,
  by: Types.ObjectId | null,
): Promise<CampaignDoc> => {
  const account = await accountFacts(campaign.accountId);
  if (account.status === 'suspended') {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The account is suspended.');
  }
  const blocker = await hooks.resumeBlocker(campaign);
  if (blocker) throw new ConflictError('CONFLICT_INVALID_STATE', blocker);
  if (!campaign.startedAt) {
    // a recurring parent continues with the next occurrence from now (missed ones are skipped)
    const scheduled = await setStatus(campaign, 'scheduled', {
      by,
      set: campaign.schedule.recurrence
        ? { nextRunAt: firstRunAt(campaign.schedule, new Date()) }
        : {},
    });
    await hooks.scheduled(scheduled);
    return scheduled;
  }
  const running = await setStatus(campaign, 'running', { by });
  await hooks.running(running);
  return running;
};

export const resumeCampaign = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  if (campaign.status !== 'paused') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `A ${campaign.status} campaign can't be resumed.`,
    );
  }
  if (campaign.pauseReason === 'admin') {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Paused by the platform team — only they can resume it.',
    );
  }
  const resumed = await resumeCampaignDoc(campaign, userOf(req));
  await auditRequest(req, 'campaign.resumed', { target: target(resumed), meta: { auto: false } });
  return view(resumed);
};

export const cancelCampaign = async (req: Request, id: string, hangUpLive: boolean) => {
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  if (!canMoveCampaign(campaign.status, 'canceled')) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `A ${campaign.status} campaign can't be canceled.`,
    );
  }
  const canceled = await setStatus(campaign, 'canceled', {
    by: userOf(req),
    set: { canceledAt: new Date(), nextRunAt: null },
  });
  const waiting = await CampaignContactModel.updateMany(
    { campaignId: campaign._id, status: { $in: CLAIMABLE_STATUSES } },
    { $set: { status: 'canceled', nextAttemptAt: null } },
  );
  if (waiting.modifiedCount) {
    const pending = await CampaignContactModel.countDocuments({
      campaignId: campaign._id,
      status: 'canceled',
    });
    await CampaignModel.updateOne(
      { _id: campaign._id },
      { $set: { 'stats.pending': 0, 'stats.waiting': 0, 'stats.canceled': pending } },
    );
  }
  await hooks.unscheduled(canceled);
  if (hangUpLive) await hooks.hangUpLive(canceled);
  await auditRequest(req, 'campaign.canceled', { target: target(canceled), meta: { hangUpLive } });
  return view(await findCampaign(accountId, id));
};

/**
 * Errors that mean "this campaign can't start" (runnable checks, or a flow /
 * version that can no longer be loaded) — the campaign ends `failed`, no retry.
 */
export const isNotRunnableError = (err: unknown): err is AppError =>
  err instanceof AppError &&
  (err.code === 'CAMPAIGN_NOT_RUNNABLE' || err.code === 'VALIDATION_FAILED');

/** Starts a scheduled campaign (job / sweep); an unrunnable one ends `failed` with its code. */
export const startScheduled = async (
  campaign: CampaignDoc,
  logger: Pick<Logger, 'warn'>,
): Promise<void> => {
  if (campaign.status !== 'scheduled' || campaign.schedule.recurrence) return;
  try {
    await beginRun(campaign, campaign.startedBy);
  } catch (err) {
    if (!isNotRunnableError(err)) throw err;
    logger.warn({ campaignId: campaign._id.toString(), code: err.code }, 'campaign: start failed');
    await setStatus(campaign, 'failed', { set: { error: { code: 'CAMPAIGN_NOT_RUNNABLE' } } });
  }
};
