import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';

import { CAMPAIGN_LIMITS } from '../../config/limits';
import { availableMicros } from '../../core/billing/events';
import { getOrCreateWallet } from '../../core/billing/wallets';
import { notifyAccount } from '../../core/realtime/notify';
import { systemClock, type Clock } from '../../core/voice/clock';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import {
  CampaignContactModel,
  CLAIMABLE_STATUSES,
  type CampaignContactDoc,
  type CampaignContactStatus,
} from '../../db/models/campaign-contact.model';
import {
  CAMPAIGN_PRIORITIES,
  CampaignModel,
  type CampaignDoc,
} from '../../db/models/campaign.model';
import { ContactModel } from '../../db/models/contact.model';
import { FlowModel } from '../../db/models/flow.model';
import { AppError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import type { CallManager } from '../calls/call.service';
import type { CallEndedSummary } from '../calls/session';

import { accountFacts, pauseCampaignDoc, pinnedProblems, setStatus } from './campaigns.service';
import { decideDial, loadContactFacts } from './dial-guard';
import { publishProgress } from './progress';
import { classifyResult } from './results';
import type { DialRate } from './slots';
import { contactCounts, countsToStats, STATUS_STAT } from './snapshot';
import { canDialAt, effectiveWindow, nextWindowStart } from './window';

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;
const RUNNABLE_CHECK_MS = 30_000;
const WINDOW_RECHECK_MS = 60_000;
const OPEN: readonly CampaignContactStatus[] = [
  'pending',
  'queued',
  'calling',
  'retry_wait',
  'callback_wait',
];

export interface DispatcherDeps {
  calls: CallManager;
  rate: DialRate;
  logger: Logger;
  clock?: Clock;
}

/** `stats.*` `$inc` for a contact moving `from` → `to`. */
export const moveStats = (from: CampaignContactStatus, to: CampaignContactStatus) => {
  const a = STATUS_STAT[from];
  const b = STATUS_STAT[to];
  if (a === b) return {};
  return { [`stats.${a}`]: -1, [`stats.${b}`]: 1 };
};

/**
 * Per-account dial loops in the process that owns the calls (PHASE_8_PROMPT §1
 * "Dispatcher"): running campaigns by priority (round robin inside one), the
 * calling window, money, then slot + rate + claim + dial guard + dial.
 */
export class CampaignDispatcher {
  private readonly clock: Clock;
  private readonly loops = new Map<string, unknown>();
  private readonly ticking = new Set<string>();
  private readonly again = new Set<string>();
  /** Campaign id → when its pinned version was last seen runnable (checked every 30 s). */
  private readonly runnableAt = new Map<string, number>();
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  constructor(private readonly deps: DispatcherDeps) {
    this.clock = deps.clock ?? systemClock;
    // returned: CallManager.shutdown() waits for the results of the calls it ends
    deps.calls.onCallEnded((summary) =>
      this.callEnded(summary).catch((err: unknown) =>
        deps.logger.error({ err, callId: summary.callId }, 'campaign: result failed'),
      ),
    );
  }

  /** Starts (or keeps) the loop of an account. */
  ensureAccount(accountId: string): void {
    if (this.stopped || this.loops.has(accountId)) return;
    this.schedule(accountId, 0);
  }

  /** Runs a tick soon (debounced). */
  wake(accountId: string): void {
    if (this.stopped) return;
    const handle = this.loops.get(accountId);
    if (handle !== undefined) this.clock.clearTimeout(handle);
    this.schedule(accountId, CAMPAIGN_LIMITS.wakeDebounceMs);
  }

  /** No new ticks; resolves when the ticks in flight are done (before calls / Mongo close). */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const h of this.loops.values()) this.clock.clearTimeout(h);
    this.loops.clear();
    await Promise.all([...this.running]);
  }

  private schedule(accountId: string, ms: number): void {
    this.loops.set(
      accountId,
      this.clock.setTimeout(() => {
        this.loops.delete(accountId);
        void this.tick(accountId).catch((err: unknown) =>
          this.deps.logger.error({ err, accountId }, 'campaign: tick failed'),
        );
      }, ms),
    );
  }

  /** One pass over the account's running campaigns; re-arms itself while any runs. */
  async tick(accountId: string): Promise<void> {
    const work = this.runTick(accountId);
    const tracked = work.catch(() => undefined);
    this.running.add(tracked);
    try {
      await work;
    } finally {
      this.running.delete(tracked);
    }
  }

  private async runTick(accountId: string): Promise<void> {
    if (this.stopped) return;
    if (this.ticking.has(accountId)) {
      this.again.add(accountId);
      return;
    }
    this.ticking.add(accountId);
    try {
      const busy = await this.pass(accountId);
      if (busy && !this.stopped && !this.loops.has(accountId)) {
        this.schedule(accountId, CAMPAIGN_LIMITS.tickMs);
      }
    } finally {
      this.ticking.delete(accountId);
      if (this.again.delete(accountId)) this.wake(accountId);
    }
  }

  private async pass(accountId: string): Promise<boolean> {
    const now = new Date(this.clock.now());
    const running = (
      await CampaignModel.find({ accountId, status: 'running' }).lean<CampaignDoc[]>()
    ).sort(
      (a, b) =>
        PRIORITY_RANK[a.pacing.priority] - PRIORITY_RANK[b.pacing.priority] ||
        (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0),
    );
    if (!running.length) return false;
    const account = await accountFacts(new Types.ObjectId(accountId));
    if (account.status === 'suspended') {
      for (const c of running)
        await pauseCampaignDoc(c, 'account_suspended', null).catch(() => undefined);
      return false;
    }
    const ready: {
      campaign: CampaignDoc;
      window: NonNullable<ReturnType<typeof effectiveWindow>>;
      templateKey: string | null;
    }[] = [];
    for (const campaign of running) {
      if (campaign.schedule.endAt && campaign.schedule.endAt.getTime() <= now.getTime()) {
        await completeCampaign(campaign, 'campaign_ended');
        continue;
      }
      if (!campaign.snapshot.done) continue; // the sweep resumes it
      if (!(await this.stillRunnable(campaign))) {
        await pauseCampaignDoc(campaign, 'flow_not_runnable', null).catch(() => undefined);
        continue;
      }
      const window = effectiveWindow({
        account: account.window,
        campaign: campaign.window,
        live: campaign.mode === 'live',
        recovery: false,
      });
      if (!window) continue;
      if (!canDialAt(now, window, campaign.schedule.timezone)) {
        const next = nextWindowStart(now, window, campaign.schedule.timezone);
        await this.waiting(campaign, next);
        // wake at the window start, and at least every minute: an edit made in
        // another process (or a sweep) must not wait for that start
        if (next) {
          this.schedule(
            accountId,
            Math.min(WINDOW_RECHECK_MS, Math.max(1_000, next.getTime() - now.getTime())),
          );
        }
        continue;
      }
      if (campaign.waitingUntil) await this.waiting(campaign, null);
      if (!(await this.moneyOk(campaign))) {
        await pauseCampaignDoc(campaign, 'wallet_empty', null).catch(() => undefined);
        continue;
      }
      const flow = await FlowModel.findById(campaign.flowId, null, { withDeleted: true })
        .select({ templateKey: 1 })
        .lean<{ templateKey: string | null }>();
      ready.push({ campaign, window, templateKey: flow?.templateKey ?? null });
    }
    // high → normal → low: a priority fills the slots before the next one gets a turn;
    // equal priority round robin (one dial per campaign per turn)
    for (const priority of CAMPAIGN_PRIORITIES) {
      const group = ready.filter((item) => item.campaign.pacing.priority === priority);
      let progress = true;
      const blocked = new Set<string>();
      while (progress) {
        progress = false;
        for (const item of group) {
          const id = item.campaign._id.toString();
          if (blocked.has(id)) continue;
          const r = await this.dialOne(item.campaign, item.window, item.templateKey, account, now);
          if (r === 'dialed' || r === 'handled') progress = true;
          else blocked.add(id);
        }
      }
    }
    return true;
  }

  private async waiting(campaign: CampaignDoc, until: Date | null): Promise<void> {
    if ((campaign.waitingUntil?.getTime() ?? null) === (until?.getTime() ?? null)) return;
    await CampaignModel.updateOne({ _id: campaign._id }, { $set: { waitingUntil: until } });
    notifyAccount(campaign.accountId.toString(), 'campaign.status', {
      campaignId: campaign._id.toString(),
      status: campaign.status,
      ...(until ? { waitingUntil: until.toISOString() } : {}),
    });
  }

  /** The pinned version can still run (an agent switched off would fail every call). */
  private async stillRunnable(campaign: CampaignDoc): Promise<boolean> {
    const id = campaign._id.toString();
    const now = this.clock.now();
    if (now - (this.runnableAt.get(id) ?? -Infinity) < RUNNABLE_CHECK_MS) return true;
    if ((await pinnedProblems(campaign)).length) {
      this.runnableAt.delete(id);
      return false;
    }
    this.runnableAt.set(id, now);
    return true;
  }

  /** Real campaigns: something left in the wallet; dry runs: the virtual balance. */
  async moneyOk(campaign: CampaignDoc): Promise<boolean> {
    return (await virtualRoom(campaign)) > 0;
  }

  private async dialOne(
    campaign: CampaignDoc,
    window: NonNullable<ReturnType<typeof effectiveWindow>>,
    templateKey: string | null,
    account: Awaited<ReturnType<typeof accountFacts>>,
    now: Date,
  ): Promise<'dialed' | 'handled' | 'empty' | 'blocked'> {
    const live = await CallModel.countDocuments({
      campaignId: campaign._id,
      status: { $in: ['queued', 'ringing', 'in_progress'] },
    });
    if (live >= campaign.pacing.concurrency) return 'blocked';
    // dry runs pace in virtual time: N per (virtual) minute = N × speed per real minute
    const scale = campaign.mode === 'dry_run' ? (campaign.dryRun?.speed ?? 1) : 1;
    const wait = await this.deps.rate.take({
      accountId: campaign.accountId.toString(),
      campaignId: campaign._id.toString(),
      perMinute: {
        account: account.limits.dialsPerMinute * scale,
        campaign: campaign.pacing.dialsPerMinute * scale,
      },
    });
    if (wait > 0) {
      this.schedule(campaign.accountId.toString(), wait);
      return 'blocked';
    }
    const cc = await CampaignContactModel.findOneAndUpdate(
      {
        campaignId: campaign._id,
        status: { $in: CLAIMABLE_STATUSES },
        nextAttemptAt: { $lte: now },
      },
      { $set: { status: 'queued', claimToken: randomUUID(), claimedAt: now } },
      { sort: { dueRank: 1, nextAttemptAt: 1, seq: 1 }, returnDocument: 'before' },
    ).lean<CampaignContactDoc>();
    if (!cc) {
      await completeIfDone(campaign);
      return 'empty';
    }
    await CampaignModel.updateOne({ _id: campaign._id }, { $inc: moveStats(cc.status, 'queued') });
    // dry runs live in virtual time: the gap between two calls shrinks with the speed
    // (like the retry interval); daily / weekly caps keep real days
    const caps = {
      ...account.caps,
      minGapMinutes: account.caps.minGapMinutes / scale,
    };
    const facts = await loadContactFacts({
      accountId: campaign.accountId.toString(),
      contactId: cc.contactId.toString(),
      phone: cc.phoneE164,
      mode: campaign.mode,
      now,
      timezone: campaign.schedule.timezone,
      minGapMinutes: caps.minGapMinutes,
    });
    const decision = decideDial({
      now,
      accountStatus: account.status,
      campaignStatus: 'running',
      window,
      timezone: campaign.schedule.timezone,
      endAt: campaign.schedule.endAt,
      ...facts,
      caps,
      money: 'ok',
    });
    if (decision.kind === 'skip') {
      await this.settleContact(campaign, cc, 'skipped', {
        skipReason: decision.reason,
        nextAttemptAt: null,
      });
      return 'handled';
    }
    if (decision.kind === 'wait') {
      await this.settleContact(campaign, cc, cc.status, {
        nextAttemptAt: decision.until,
        waitReason: decision.reason,
      });
      return 'handled';
    }
    if (decision.kind !== 'dial') {
      await this.settleContact(campaign, cc, cc.status, {});
      if (decision.kind === 'pause')
        await pauseCampaignDoc(campaign, decision.reason, null).catch(() => undefined);
      return 'blocked';
    }
    // the call's number: every dial counts here, also the ones a shutdown gave back
    const attempt = Math.max(cc.dials ?? 0, cc.attempts) + 1;
    try {
      const out = await this.deps.calls.startOutboundCall({
        accountId: campaign.accountId.toString(),
        provider: campaign.mode === 'live' ? 'sip' : 'dryrun',
        to: cc.phoneE164,
        contactId: cc.contactId.toString(),
        source: {
          kind: 'flow',
          flowId: campaign.flowId,
          flowVersionRef: campaign.flowVersion ?? undefined,
          flowVersionId: campaign.flowVersionId,
        },
        variables: cc.variables,
        campaign: {
          campaignId: campaign._id.toString(),
          campaignContactId: cc._id.toString(),
          attempt,
        },
        initiatedBy: null,
        groupLimit: campaign.pacing.concurrency,
        ...(campaign.dryRun
          ? {
              dryRun: {
                seed: `${cc._id.toString()}:${String(attempt)}`,
                mix: campaign.dryRun.mix,
                scenarios: campaign.dryRun.scenarios,
                templateKey,
                speed: campaign.dryRun.speed,
                gate: (micros: number) => virtualRoom(campaign).then((room) => room >= micros),
              },
            }
          : {}),
      });
      await CampaignContactModel.updateOne(
        { _id: cc._id },
        {
          $set: {
            status: 'calling',
            lastCallId: new Types.ObjectId(out.callId),
            lastAttemptAt: now,
            dials: attempt,
            waitReason: null,
          },
          $inc: { attempts: 1 },
        },
      );
      await CampaignModel.updateOne(
        { _id: campaign._id },
        { $inc: { ...moveStats('queued', 'calling'), 'stats.attempts': 1 } },
      );
      // canceled while this contact was being dialed: its hang-up missed this call
      if (await CampaignModel.exists({ _id: campaign._id, status: 'canceled' })) {
        await this.deps.calls.hangupCampaign(campaign._id.toString());
        return 'blocked';
      }
      return 'dialed';
    } catch (err) {
      await this.settleContact(campaign, cc, cc.status, {});
      const code = err instanceof AppError ? err.code : null;
      if (code === 'WALLET_INSUFFICIENT_BALANCE') {
        await pauseCampaignDoc(campaign, 'wallet_empty', null).catch(() => undefined);
      } else if (code !== 'CALL_LIMIT_REACHED' && code !== 'CALL_CAPACITY') {
        this.deps.logger.error(
          { err, campaignId: campaign._id.toString() },
          'campaign: dial failed',
        );
      }
      return 'blocked';
    }
  }

  /** A claimed contact goes back (or on) to `to`. */
  private async settleContact(
    campaign: CampaignDoc,
    cc: CampaignContactDoc,
    to: CampaignContactStatus,
    set: Record<string, unknown>,
  ): Promise<void> {
    await CampaignContactModel.updateOne(
      { _id: cc._id, status: 'queued' },
      { $set: { status: to, claimToken: null, claimedAt: null, ...set } },
    );
    const inc: Record<string, number> = { ...moveStats('queued', to) };
    if (to === 'skipped' && typeof set.skipReason === 'string')
      inc[`stats.skippedBy.${set.skipReason}`] = 1;
    await CampaignModel.updateOne({ _id: campaign._id }, { $inc: inc });
  }

  /**
   * A campaign call ended: apply its result once, then wake the account. A
   * "Call now" call (outbound to a contact, no campaign) updates the contact's
   * call facts; browser test calls do not.
   */
  async callEnded(summary: CallEndedSummary): Promise<void> {
    const call = await CallModel.findById(summary.callId).lean<CallDoc>();
    if (call && !call.campaignId && call.contactId && call.provider !== 'webcall') {
      await recordContactCall(call.contactId, call.createdAt, call.disposition);
      return;
    }
    if (!call?.campaignId || !call.campaignContactId) return;
    await applyResult(call, new Date(this.clock.now()));
    this.wake(call.accountId.toString());
  }
}

/** The contact's `lastCalledAt` / `callCount` / `lastDisposition` after one of its calls. */
const recordContactCall = (contactId: Types.ObjectId, at: Date, disposition: string | null) =>
  ContactModel.updateOne(
    { _id: contactId },
    {
      $set: { lastCalledAt: at, ...(disposition ? { lastDisposition: disposition } : {}) },
      $inc: { callCount: 1 },
    },
  );

/** Room left on the virtual (dry run) or real wallet, in micros. */
export const virtualRoom = async (campaign: CampaignDoc): Promise<number> => {
  const available = availableMicros(await getOrCreateWallet(campaign.accountId));
  if (campaign.mode === 'live') return available;
  const fresh = await CampaignModel.findById(campaign._id)
    .select({ 'stats.virtualCostMicros': 1 })
    .lean<{ stats: { virtualCostMicros: number } }>();
  return available - (fresh?.stats.virtualCostMicros ?? 0);
};

/** Applies a finished campaign call to its contact, the stats and the contact (idempotent). */
export const applyResult = async (call: CallDoc, now: Date): Promise<void> => {
  const campaign = await CampaignModel.findById(call.campaignId).lean<CampaignDoc>();
  if (!campaign || !call.campaignContactId) return;
  const cc = await CampaignContactModel.findOne({
    _id: call.campaignContactId,
    status: 'calling',
    lastCallId: call._id,
  }).lean<CampaignContactDoc>();
  if (!cc) return; // applied already (or released)
  const outcome = classifyResult({
    call: {
      status: call.status,
      endReason: call.endReason,
      answered: call.timestamps.answeredAt !== null,
      disposition: call.disposition,
      outcome: call.outcome,
      costMicros: call.cost.totalMicros,
    },
    campaign,
    attempts: cc.attempts,
    now,
  });
  const updated = await CampaignContactModel.updateOne(
    { _id: cc._id, status: 'calling', lastCallId: call._id },
    {
      $set: {
        status: outcome.status,
        dueRank: outcome.dueRank,
        nextAttemptAt: outcome.nextAttemptAt,
        lastResult: outcome.lastResult,
        skipReason: outcome.skipReason,
        disposition: outcome.disposition ?? cc.disposition,
        callback: outcome.callback ?? cc.callback,
        promiseToPay: outcome.promiseToPay ?? cc.promiseToPay,
        claimToken: null,
        claimedAt: null,
      },
      $inc: {
        costMicros: call.cost.totalMicros,
        ...(outcome.countsAttempt ? {} : { attempts: -1 }),
      },
    },
  );
  if (!updated.modifiedCount) return;
  const inc: Record<string, number> = {
    ...moveStats('calling', outcome.status),
    ...(outcome.lastResult === 'answered' ? { 'stats.answered': 1 } : {}),
    ...(outcome.countsAttempt ? {} : { 'stats.attempts': -1 }),
    ...(outcome.disposition ? { [`stats.dispositions.${outcome.disposition}`]: 1 } : {}),
    ...(outcome.skipReason ? { [`stats.skippedBy.${outcome.skipReason}`]: 1 } : {}),
    [call.charged ? 'stats.spentMicros' : 'stats.virtualCostMicros']: call.cost.totalMicros,
  };
  const streak = outcome.technical
    ? { $inc: { 'stats.failureStreak': 1 } }
    : outcome.lastResult === 'answered'
      ? { $set: { 'stats.failureStreak': 0 } }
      : {};
  const after = await CampaignModel.findOneAndUpdate(
    { _id: campaign._id },
    {
      $inc: { ...inc, ...('$inc' in streak ? streak.$inc : {}) },
      ...('$set' in streak ? { $set: streak.$set } : {}),
    },
    { returnDocument: 'after' },
  ).lean<CampaignDoc>();
  await recordContactCall(cc.contactId, call.createdAt, outcome.disposition);
  if (!after) return;
  publishProgress(campaign._id.toString());
  if (after.status === 'running' && after.stats.failureStreak >= CAMPAIGN_LIMITS.failuresToPause) {
    await pauseCampaignDoc(after, 'too_many_failures', null).catch(() => undefined);
    return;
  }
  await completeIfDone(after);
};

/** Completes a running campaign with nothing left to dial or wait for. */
export const completeIfDone = async (campaign: CampaignDoc): Promise<void> => {
  if (campaign.status !== 'running' || !campaign.snapshot.done) return;
  const open = await CampaignContactModel.exists({
    campaignId: campaign._id,
    status: { $in: OPEN },
  });
  if (open) return;
  await setStatus(campaign, 'completed', { set: { completedAt: new Date() } }).catch(
    () => undefined,
  );
};

/** `endAt` reached: waiting contacts are skipped, the campaign completes. */
export const completeCampaign = async (
  campaign: CampaignDoc,
  reason: 'campaign_ended',
): Promise<void> => {
  await CampaignContactModel.updateMany(
    { campaignId: campaign._id, status: { $in: CLAIMABLE_STATUSES } },
    { $set: { status: 'skipped', skipReason: reason, nextAttemptAt: null } },
  );
  await CampaignModel.updateOne(
    { _id: campaign._id },
    { $set: countsToStats(await contactCounts(campaign._id)) },
  );
  publishProgress(campaign._id.toString());
  await setStatus(campaign, 'completed', { set: { completedAt: new Date() } }).catch(
    () => undefined,
  );
};
