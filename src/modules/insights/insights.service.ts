/**
 * Post-call AI insights (Phase 14, ADR 0044): summary, outcome, sentiment and key facts
 * for every answered call with a transcript. `insights.sweep` (AI queue, every minute)
 * looks at calls that ended and nobody reviewed (`insights: null`) — every call path
 * (phone, browser test, WhatsApp AI / human) without a hook — and queues
 * `insights.run`. Prepaid AI usage, charged once per version. Never logs transcript,
 * summary or prompt text.
 */
import type { Request } from 'express';
import { Types } from 'mongoose';

import { INSIGHTS_LIMITS } from '../../config/limits';
import type { AiJobs } from '../../core/ai/jobs';
import { turnCost } from '../../core/ai/pricing';
import {
  INSIGHTS_FORMAT_NAME,
  INSIGHTS_JSON_SCHEMA,
  INSIGHTS_PROMPT_VERSION,
  insightsMessages,
} from '../../core/ai/prompts/insights';
import type { AiProvider, TokenUsage } from '../../core/ai/types';
import { chargeUsage } from '../../core/billing/engine';
import { effectiveRateCard } from '../../core/billing/rates';
import { getOrCreateWallet } from '../../core/billing/wallets';
import { tryGetRealtime } from '../../core/realtime';
import {
  AccountModel,
  DEFAULT_DISPOSITIONS,
  DEFAULT_INSIGHTS_SETTINGS,
  DEFAULT_WHATSAPP_CALLING_SETTINGS,
  type AccountDisposition,
  type AccountDoc,
} from '../../db/models/account.model';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { CallInsightModel, type CallInsightDoc } from '../../db/models/call-insight.model';
import { CallModel, type CallDoc, type CallInsightsState } from '../../db/models/call.model';
import { FlowModel } from '../../db/models/flow.model';
import { TranscriptTurnModel } from '../../db/models/transcript-turn.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { ymdInZone } from '../../shared/time';
import { auditRequest } from '../audit/audit.service';

import { ModelInsightsSchema, toInsightOutput } from './insights.schema';

export const INSIGHT_JOBS = {
  sweep: 'insights.sweep',
  run: 'insights.run',
  stt: 'insights.stt',
  chatSummary: 'insights.chat_summary',
} as const;
export const insightRunJobId = (callId: string, version: number): string =>
  `insights-${callId}-v${String(version)}`;

/** Loan facts the model may see (never phone, e-mail, name or external ids). */
const FACT_KEYS = ['loan_amount', 'emi_amount', 'due_date', 'days_past_due', 'branch'] as const;
const FINAL_STATUSES = ['completed', 'failed', 'busy', 'no_answer', 'canceled'];

export interface InsightsDeps {
  provider?: AiProvider;
  /** Text model (`OPENAI_TEXT_MODEL`). */
  model: string;
  jobs: AiJobs;
  now?: () => Date;
}

type AccountView = Pick<AccountDoc, '_id' | 'timezone' | 'settings'>;

export interface InsightsSettingsView {
  enabled: boolean;
  chatSummaryOnClose: boolean;
  transcribeHumanCalls: boolean;
}

export const insightsSettingsOf = (
  account: Pick<AccountDoc, 'settings'>,
): InsightsSettingsView => ({
  enabled: account.settings.insights?.enabled ?? DEFAULT_INSIGHTS_SETTINGS.enabled,
  chatSummaryOnClose:
    account.settings.insights?.chatSummaryOnClose ?? DEFAULT_INSIGHTS_SETTINGS.chatSummaryOnClose,
  transcribeHumanCalls:
    account.settings.whatsappCalling?.transcribeHumanCalls ??
    DEFAULT_WHATSAPP_CALLING_SETTINGS.transcribeHumanCalls,
});

export const dispositionsOf = (account: Pick<AccountDoc, 'settings'>): AccountDisposition[] =>
  account.settings.dispositions?.length ? account.settings.dispositions : DEFAULT_DISPOSITIONS;

const loadAccount = async (accountId: Types.ObjectId): Promise<AccountView> => {
  const account = await AccountModel.findById(accountId)
    .select({ timezone: 1, settings: 1 })
    .lean<AccountView>();
  if (!account) throw new NotFoundError('Account not found');
  return account;
};

const customerTurns = (callId: Types.ObjectId, accountId: Types.ObjectId) =>
  TranscriptTurnModel.countDocuments({
    accountId,
    callId,
    speaker: 'customer',
    source: { $ne: 'dtmf' },
    text: { $nin: ['', null] },
  });

const state = (
  status: CallInsightsState['status'],
  version: number,
  reason: string | null,
  at: Date,
  extra: Partial<CallInsightsState> = {},
): CallInsightsState => ({
  status,
  reason,
  version,
  sentiment: null,
  hasPromise: false,
  promiseAmountMicros: null,
  hasSummary: false,
  at,
  ...extra,
});

const emit = (callId: Types.ObjectId, status: string, version: number): void => {
  const rt = tryGetRealtime();
  if (!rt) return;
  void rt
    .pushToTopic(`call:${callId.toString()}`, 'call.insights', {
      callId: callId.toString(),
      status,
      version,
    })
    .catch((err: unknown) => {
      getLogger().warn({ err }, 'insights: realtime push failed');
    });
};

/** Why the call can't be reviewed now (`null` = it can). */
const blocker = async (
  call: Pick<CallDoc, '_id' | 'accountId' | 'timestamps' | 'status'>,
  settings: InsightsSettingsView,
): Promise<'not_answered' | 'disabled' | 'too_short' | null> => {
  if (!call.timestamps.answeredAt) return 'not_answered';
  if (!settings.enabled) return 'disabled';
  if ((await customerTurns(call._id, call.accountId)) < INSIGHTS_LIMITS.minCustomerTurns)
    return 'too_short';
  return null;
};

/**
 * `insights.sweep`: decides once for each call that ended (and settled for
 * `settleSec`): skipped with a reason, or `pending` + an `insights.run` job.
 */
export const sweepInsights = async (deps: InsightsDeps): Promise<Record<string, number>> => {
  const now = deps.now?.() ?? new Date();
  const calls = await CallModel.find({
    insights: null,
    'timestamps.endedAt': {
      $gte: new Date(now.getTime() - INSIGHTS_LIMITS.sweepLookbackHours * 3_600_000),
      $lte: new Date(now.getTime() - INSIGHTS_LIMITS.settleSec * 1000),
    },
  })
    .sort({ 'timestamps.endedAt': 1 })
    .limit(INSIGHTS_LIMITS.sweepBatch)
    .select({ accountId: 1, status: 1, timestamps: 1, mode: 1, recording: 1 })
    .lean<Pick<CallDoc, '_id' | 'accountId' | 'status' | 'timestamps' | 'mode' | 'recording'>[]>();
  const accounts = new Map<string, AccountView>();
  let queued = 0;
  let skipped = 0;
  for (const call of calls) {
    if (!FINAL_STATUSES.includes(call.status)) continue;
    const key = call.accountId.toString();
    const account = accounts.get(key) ?? (await loadAccount(call.accountId).catch(() => null));
    if (!account) continue;
    accounts.set(key, account);
    const settings = insightsSettingsOf(account);
    let reason: string | null = await blocker(call, settings);
    if (reason === 'too_short' && call.mode === 'human') {
      // a recorded human call is transcribed first when the account asked for it
      if (settings.transcribeHumanCalls && call.recording) {
        const claimed = await CallModel.updateOne(
          { _id: call._id, insights: null },
          { $set: { insights: state('pending', 1, null, now) } },
        );
        if (!claimed.modifiedCount) continue;
        await CallInsightModel.updateOne(
          { accountId: call.accountId, callId: call._id, version: 1 },
          { $setOnInsert: { status: 'pending', promptVersion: INSIGHTS_PROMPT_VERSION } },
          { upsert: true },
        );
        await deps.jobs.enqueue(
          INSIGHT_JOBS.stt,
          { accountId: key, callId: call._id.toString() },
          { jobId: `stt-${call._id.toString()}` },
        );
        queued += 1;
        continue;
      }
      reason = 'no_transcript';
    }
    if (reason) {
      skipped += 1;
      await CallModel.updateOne(
        { _id: call._id, insights: null },
        { $set: { insights: state('skipped', 0, reason, now) } },
      );
      continue;
    }
    const claimed = await CallModel.updateOne(
      { _id: call._id, insights: null },
      { $set: { insights: state('pending', 1, null, now) } },
    );
    if (!claimed.modifiedCount) continue;
    await CallInsightModel.updateOne(
      { accountId: call.accountId, callId: call._id, version: 1 },
      { $setOnInsert: { status: 'pending', promptVersion: INSIGHTS_PROMPT_VERSION } },
      { upsert: true },
    );
    await deps.jobs.enqueue(
      INSIGHT_JOBS.run,
      { accountId: key, callId: call._id.toString(), version: 1 },
      { jobId: insightRunJobId(call._id.toString(), 1) },
    );
    queued += 1;
  }
  return { seen: calls.length, queued, skipped };
};

const middleCut = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, Math.floor(max / 2))}\n[…]\n${text.slice(text.length - Math.floor(max / 2))}`;

const programName = async (call: Pick<CallDoc, 'accountId' | 'source'>): Promise<string | null> => {
  if (call.source.flowId) {
    const flow = await FlowModel.findOne({ _id: call.source.flowId, accountId: call.accountId })
      .select({ name: 1 })
      .lean<{ name: string }>();
    return flow ? `the call flow "${flow.name}"` : null;
  }
  if (call.source.agentId) {
    const agent = await AiAgentModel.findOne({
      _id: call.source.agentId,
      accountId: call.accountId,
    })
      .select({ name: 1 })
      .lean<{ name: string }>();
    return agent ? `the AI agent "${agent.name}"` : null;
  }
  return null;
};

export const finishInsights = async (
  call: Pick<CallDoc, '_id' | 'accountId'>,
  version: number,
  status: 'skipped' | 'failed',
  reason: string,
  now: Date,
): Promise<{ status: string; reason: string }> => {
  await CallInsightModel.updateOne(
    { accountId: call.accountId, callId: call._id, version },
    { $set: { status, reason } },
    { upsert: true },
  );
  await CallModel.updateOne(
    { _id: call._id, 'insights.version': version },
    { $set: { insights: state(status, version, reason, now) } },
  );
  emit(call._id, status, version);
  return { status, reason };
};

export interface InsightRunData {
  accountId: string;
  callId: string;
  version: number;
}

/** `insights.run`: one model call (plus one retry on invalid output), stored, charged. */
export const runInsights = async (
  data: InsightRunData,
  deps: InsightsDeps,
  attempt: { made: number; max: number } = { made: 0, max: 1 },
): Promise<{ status: string; reason?: string }> => {
  const now = deps.now?.() ?? new Date();
  const accountId = new Types.ObjectId(data.accountId);
  const call = await CallModel.findOne({ _id: data.callId, accountId }).lean<CallDoc>();
  if (
    !call?.insights ||
    call.insights.version !== data.version ||
    call.insights.status !== 'pending'
  )
    return { status: 'stale' };
  const account = await loadAccount(accountId);
  const wallet = await getOrCreateWallet(accountId);
  if (wallet.balanceMicros - wallet.holdMicros <= 0)
    return finishInsights(call, data.version, 'skipped', 'low_balance', now);
  if (!deps.provider) throw new Error('AI provider is not configured for the worker');

  const turns = await TranscriptTurnModel.find({ accountId, callId: call._id })
    .sort({ seq: 1 })
    .select({ speaker: 1, text: 1, source: 1 })
    .lean<{ speaker: string; text: string; source: string }[]>();
  const transcript = middleCut(
    turns
      .filter((t) => t.text && t.source !== 'dtmf')
      .map((t) => `[${t.speaker}] ${t.text.replace(/\s+/g, ' ').trim()}`)
      .join('\n'),
    INSIGHTS_LIMITS.maxTranscriptChars,
  );
  const dispositions = dispositionsOf(account).filter((d) => d.active);
  const facts = Object.fromEntries(
    FACT_KEYS.filter((k) => typeof call.variables[k] === 'string' && call.variables[k] !== '').map(
      (k) => [k, call.variables[k] as string],
    ),
  );
  const messages = insightsMessages({
    callDate: ymdInZone(call.createdAt, account.timezone),
    programName: await programName(call),
    dispositions,
    facts,
    transcript,
  });

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let output: ReturnType<typeof toInsightOutput> | null = null;
  try {
    for (let i = 0; i <= INSIGHTS_LIMITS.retries && !output; i += 1) {
      const result = await deps.provider.chat({
        model: deps.model,
        messages,
        responseFormat: {
          type: 'json_schema',
          name: INSIGHTS_FORMAT_NAME,
          schema: INSIGHTS_JSON_SCHEMA,
        },
        temperatureTenths: 2,
        maxOutputTokens: INSIGHTS_LIMITS.maxOutputTokens,
      });
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        parsed = null;
      }
      const checked = ModelInsightsSchema.safeParse(parsed);
      if (checked.success)
        output = toInsightOutput(
          checked.data,
          dispositions.map((d) => d.key),
        );
    }
  } catch (err) {
    if (attempt.made + 1 < attempt.max) throw err;
    getLogger().warn(
      { callId: data.callId, err: (err as Error).name },
      'insights: provider failed',
    );
    return finishInsights(call, data.version, 'failed', 'provider_error', now);
  }

  const cost = turnCost(await effectiveRateCard(accountId), usage);
  let ledgerEntryId: Types.ObjectId | null = null;
  if (cost > 0) {
    try {
      const charged = await chargeUsage({
        accountId,
        type: 'ai_charge',
        amountMicros: cost,
        breakdown: { aiMicros: cost, ...usage, model: deps.model, kind: 'insights' },
        ref: { type: 'call', id: call._id.toString() },
        idempotencyKey: insightRunJobId(call._id.toString(), data.version),
      });
      ledgerEntryId = charged.entries[0]?._id ?? null;
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === 'WALLET_INSUFFICIENT_BALANCE' || err.code === 'WALLET_BUDGET_EXCEEDED')
      )
        return finishInsights(call, data.version, 'skipped', 'low_balance', now);
      throw err;
    }
  }
  if (!output) {
    await CallInsightModel.updateOne(
      { accountId, callId: call._id, version: data.version },
      { $set: { model: deps.model, ...usage, costMicros: cost, ledgerEntryId } },
      { upsert: true },
    );
    return finishInsights(call, data.version, 'failed', 'invalid_output', now);
  }

  await CallInsightModel.updateOne(
    { accountId, callId: call._id, version: data.version },
    {
      $set: {
        status: 'done',
        reason: null,
        output,
        model: deps.model,
        promptVersion: INSIGHTS_PROMPT_VERSION,
        ...usage,
        costMicros: cost,
        ledgerEntryId,
      },
    },
    { upsert: true },
  );
  await CallModel.updateOne(
    { _id: call._id, 'insights.version': data.version },
    {
      $set: {
        insights: state('done', data.version, null, now, {
          sentiment: output.sentiment.label,
          hasPromise: Boolean(output.keyInfo.promiseDate),
          promiseAmountMicros: output.keyInfo.promiseAmountMicros,
          hasSummary: Boolean(output.summary),
        }),
      },
    },
  );
  // a flow / AI agent / person always wins; the AI only fills an empty outcome
  if (output.suggestedDisposition)
    await CallModel.updateOne(
      { _id: call._id, disposition: null },
      { $set: { disposition: output.suggestedDisposition, dispositionSource: 'ai' } },
    );
  emit(call._id, 'done', data.version);
  return { status: 'done' };
};

// ── API ─────────────────────────────────────────────────────────────────────

const versionView = (doc: CallInsightDoc, names: Map<string, string>) => ({
  version: doc.version,
  status: doc.status,
  reason: doc.reason,
  output: doc.output,
  model: doc.model,
  costMicros: doc.costMicros,
  createdBy: doc.createdBy
    ? { id: doc.createdBy.toString(), name: names.get(doc.createdBy.toString()) ?? 'Former member' }
    : null,
  createdAt: doc.createdAt.toISOString(),
});

export const insightsView = async (accountId: Types.ObjectId, callId: Types.ObjectId | string) => {
  const call = await CallModel.findOne({ _id: callId, accountId })
    .select({ insights: 1, disposition: 1, dispositionSource: 1, timestamps: 1 })
    .lean<Pick<CallDoc, '_id' | 'insights' | 'disposition' | 'dispositionSource' | 'timestamps'>>();
  if (!call) throw new NotFoundError('Call not found');
  const docs = await CallInsightModel.find({ accountId, callId: call._id })
    .sort({ version: -1 })
    .lean<CallInsightDoc[]>();
  const userIds = [...new Set(docs.flatMap((d) => (d.createdBy ? [d.createdBy.toString()] : [])))];
  const users = userIds.length
    ? await UserModel.find({ accountId, _id: { $in: userIds } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  const names = new Map(users.map((u) => [u._id.toString(), u.name]));
  const history = docs.map((d) => versionView(d, names));
  return {
    callId: call._id.toString(),
    status: call.insights?.status ?? null,
    reason: call.insights?.reason ?? null,
    disposition: call.disposition,
    dispositionSource: call.dispositionSource ?? null,
    latest: history.find((h) => h.status === 'done') ?? history[0] ?? null,
    history,
    canRegenerate: Boolean(call.timestamps.answeredAt) && call.insights?.status !== 'pending',
  };
};

export const getInsights = (req: Request, id: string) =>
  insightsView(tenantFilter(req).accountId, id);

export const regenerateInsights = async (
  req: Request,
  id: string,
  deps: Pick<InsightsDeps, 'jobs' | 'now'>,
) => {
  const { accountId } = tenantFilter(req);
  const call = await CallModel.findOne({ _id: id, accountId })
    .select({ accountId: 1, status: 1, timestamps: 1, insights: 1 })
    .lean<Pick<CallDoc, '_id' | 'accountId' | 'status' | 'timestamps' | 'insights'>>();
  if (!call) throw new NotFoundError('Call not found');
  if (call.insights?.status === 'pending')
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The insights are already being made.');
  const reason = await blocker(call, insightsSettingsOf(await loadAccount(accountId)));
  if (reason === 'disabled') throw new AppError('INSIGHTS_DISABLED');
  if (reason) throw new AppError('INSIGHTS_NOT_AVAILABLE');
  const wallet = await getOrCreateWallet(accountId);
  if (wallet.balanceMicros - wallet.holdMicros <= 0)
    throw new AppError('WALLET_INSUFFICIENT_BALANCE');
  const latest = await CallInsightModel.findOne({ accountId, callId: call._id })
    .sort({ version: -1 })
    .select({ version: 1 })
    .lean<{ version: number }>();
  const version = Math.max(latest?.version ?? 0, call.insights?.version ?? 0) + 1;
  const now = deps.now?.() ?? new Date();
  const claimed = await CallModel.updateOne(
    { _id: call._id, 'insights.status': { $ne: 'pending' } },
    { $set: { insights: state('pending', version, null, now) } },
  );
  if (!claimed.modifiedCount)
    throw new ConflictError('CONFLICT_INVALID_STATE', 'The insights are already being made.');
  await CallInsightModel.create({
    accountId,
    callId: call._id,
    version,
    status: 'pending',
    promptVersion: INSIGHTS_PROMPT_VERSION,
    createdBy: new Types.ObjectId(requireAuth(req).userId),
  });
  await deps.jobs.enqueue(
    INSIGHT_JOBS.run,
    { accountId: accountId.toString(), callId: call._id.toString(), version },
    { jobId: insightRunJobId(call._id.toString(), version) },
  );
  await auditRequest(req, 'call.insights_regenerated', {
    target: { type: 'call', id: call._id.toString() },
    meta: { version },
  });
  emit(call._id, 'pending', version);
  return insightsView(accountId, call._id);
};

export const setDisposition = async (req: Request, id: string, key: string) => {
  const { accountId } = tenantFilter(req);
  const allowed = dispositionsOf(await loadAccount(accountId)).filter((d) => d.active);
  if (!allowed.some((d) => d.key === key)) throw new AppError('DISPOSITION_UNKNOWN');
  const before = await CallModel.findOneAndUpdate(
    { _id: id, accountId },
    { $set: { disposition: key, dispositionSource: 'user' } },
  )
    .select({ disposition: 1 })
    .lean<{ _id: Types.ObjectId; disposition: string | null }>();
  if (!before) throw new NotFoundError('Call not found');
  await auditRequest(req, 'call.disposition_updated', {
    target: { type: 'call', id: before._id.toString() },
    meta: { from: before.disposition, to: key },
  });
  return insightsView(accountId, before._id);
};

export const getInsightsSettings = async (req: Request): Promise<InsightsSettingsView> =>
  insightsSettingsOf(await loadAccount(tenantFilter(req).accountId));

export const updateInsightsSettings = async (
  req: Request,
  body: { enabled?: boolean; chatSummaryOnClose?: boolean },
): Promise<InsightsSettingsView> => {
  const { accountId } = tenantFilter(req);
  const set: Record<string, boolean> = {};
  if (body.enabled !== undefined) set['settings.insights.enabled'] = body.enabled;
  if (body.chatSummaryOnClose !== undefined)
    set['settings.insights.chatSummaryOnClose'] = body.chatSummaryOnClose;
  await AccountModel.updateOne({ _id: accountId }, { $set: set });
  await auditRequest(req, 'account.insights_updated', {
    target: { type: 'account', id: accountId.toString() },
    meta: body,
  });
  return getInsightsSettings(req);
};

export const getDispositions = async (req: Request) => ({
  dispositions: dispositionsOf(await loadAccount(tenantFilter(req).accountId)),
});

export const updateDispositions = async (req: Request, list: AccountDisposition[]) => {
  const { accountId } = tenantFilter(req);
  const current = dispositionsOf(await loadAccount(accountId));
  const kept = new Set(list.map((d) => d.key));
  const removed = current.map((d) => d.key).filter((k) => !kept.has(k));
  const inUse: string[] = [];
  for (const key of removed)
    if (await CallModel.exists({ accountId, disposition: key })) inUse.push(key);
  if (inUse.length)
    throw new ValidationError(
      inUse.map((key) => ({
        path: 'dispositions',
        message: `"${key}" is used by calls — turn it off instead.`,
      })),
    );
  await AccountModel.updateOne({ _id: accountId }, { $set: { 'settings.dispositions': list } });
  await auditRequest(req, 'account.dispositions_updated', {
    target: { type: 'account', id: accountId.toString() },
    meta: {
      keys: list.map((d) => d.key),
      removed,
      inactive: list.filter((d) => !d.active).map((d) => d.key),
    },
  });
  return getDispositions(req);
};
