import { randomUUID } from 'node:crypto';

import type { Request } from 'express';
import { Types } from 'mongoose';

import { AccountModel, type AccountDoc } from '../../../db/models/account.model';
import { CallModel, type CallDoc } from '../../../db/models/call.model';
import {
  CampaignContactModel,
  CLAIMABLE_STATUSES,
  type CampaignContactDoc,
  type CampaignContactStatus,
} from '../../../db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../../db/models/campaign.model';
import { ContactModel } from '../../../db/models/contact.model';
import { UserModel } from '../../../db/models/user.model';
import { requireAuth } from '../../../shared/auth/auth-context';
import { tenantFilter } from '../../../shared/auth/tenant';
import { AppError, ForbiddenError, NotFoundError } from '../../../shared/errors/app-error';
import { auditRequest } from '../../audit/audit.service';
import type { CallManager } from '../../calls/call.service';
import { issueMediaTicket } from '../../calls/media-tickets';
import { dispositionsOf } from '../../insights/insights.service';
import { resolveCallerId } from '../../phone-numbers/phone-numbers.service';
import type { WhatsAppCallsService } from '../../whatsapp-calling/calls.service';
import { accountFacts } from '../campaigns.service';
import { decideDial, loadContactFacts } from '../dial-guard';
import { completeIfDone, moveStats, virtualRoom } from '../dispatcher';
import { publishProgress } from '../progress';
import { allowedCallContacts, validateWhatsAppLine } from '../whatsapp-line';
import { canDialAt, effectiveWindow, nextWindowStart } from '../window';

import {
  dropSlot,
  mayJoin,
  publishSession,
  readSlot,
  sessionBoard,
  writeSlot,
  type AgentSlot,
} from './session';

/**
 * CM — team calling (progressive): an agent who joined a team campaign asks for the next
 * contact; this process (the one the agent's browser talks to) claims one, runs the same
 * checks as the dialer (window, money, DND / caps, WhatsApp permission) and starts a human
 * call owned by that agent. One live call per agent: nobody is dialled without a person.
 */

export interface TeamDeps {
  manager?: CallManager | undefined;
  whatsappCalls?: Pick<WhatsAppCallsService, 'startOutbound'> | null | undefined;
}

/** How many contacts one "next" request may skip (DND, caps…) before it answers "wait". */
const MAX_SKIPS_PER_REQUEST = 25;

const agentOf = (req: Request) => {
  const auth = requireAuth(req);
  if (auth.kind !== 'user' || !auth.userId) throw new ForbiddenError();
  return { accountId: tenantFilter(req).accountId, userId: auth.userId };
};

const teamCampaign = async (accountId: Types.ObjectId, id: string, userId: string) => {
  const campaign = Types.ObjectId.isValid(id)
    ? await CampaignModel.findOne({ _id: id, accountId, deletedAt: null }).lean<CampaignDoc>()
    : null;
  if (!campaign) throw new NotFoundError('Campaign not found');
  if (campaign.talkMode !== 'team')
    throw new AppError('CONFLICT_INVALID_STATE', 'This campaign is not a team calling campaign.');
  if (!mayJoin(campaign, userId)) throw new AppError('AGENT_NOT_IN_CAMPAIGN');
  return campaign;
};

const slotOf = (state: AgentSlot['state'], over: Partial<AgentSlot> = {}): AgentSlot => ({
  state,
  since: Date.now(),
  callId: null,
  seenAt: Date.now(),
  until: null,
  ...over,
});

export const joinSession = async (req: Request, id: string) => {
  const { accountId, userId } = agentOf(req);
  const campaign = await teamCampaign(accountId, id, userId);
  const current = await readSlot(id, userId);
  // rejoining keeps a call in progress
  await writeSlot(
    id,
    userId,
    current?.state === 'on_call' ? { ...current, seenAt: Date.now() } : slotOf('ready'),
  );
  await auditRequest(req, 'campaign.agent_joined', { target: { type: 'campaign', id } });
  publishSession(campaign);
  return sessionBoard(campaign);
};

export const leaveSession = async (req: Request, id: string) => {
  const { accountId, userId } = agentOf(req);
  const campaign = await teamCampaign(accountId, id, userId);
  await dropSlot(id, userId);
  await auditRequest(req, 'campaign.agent_left', { target: { type: 'campaign', id } });
  publishSession(campaign);
  return sessionBoard(campaign);
};

/** Heartbeat, pause or back to ready. */
export const updateSession = async (
  req: Request,
  id: string,
  action: 'heartbeat' | 'pause' | 'ready',
) => {
  const { accountId, userId } = agentOf(req);
  const campaign = await teamCampaign(accountId, id, userId);
  const slot = await readSlot(id, userId);
  if (!slot) throw new AppError('AGENT_SESSION_GONE');
  const now = Date.now();
  if (action === 'heartbeat') await writeSlot(id, userId, { ...slot, seenAt: now });
  else if (slot.state !== 'on_call')
    await writeSlot(id, userId, slotOf(action === 'pause' ? 'paused' : 'ready'));
  if (action !== 'heartbeat') publishSession(campaign);
  return sessionBoard(campaign);
};

export const sessionOf = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const campaign = Types.ObjectId.isValid(id)
    ? await CampaignModel.findOne({ _id: id, accountId, deletedAt: null }).lean<CampaignDoc>()
    : null;
  if (!campaign) throw new NotFoundError('Campaign not found');
  return sessionBoard(campaign);
};

type Wait = {
  kind: 'wait';
  reason: 'not_running' | 'window' | 'wallet' | 'no_contacts' | 'line' | 'busy';
  until: string | null;
};

const wait = (reason: Wait['reason'], until: Date | null = null): Wait => ({
  kind: 'wait',
  reason,
  until: until?.toISOString() ?? null,
});

/** Puts a claimed contact back (or on) to `to` with the stats move. */
const settle = async (
  campaign: CampaignDoc,
  cc: CampaignContactDoc,
  to: CampaignContactStatus,
  set: Record<string, unknown>,
) => {
  await CampaignContactModel.updateOne(
    { _id: cc._id, status: 'queued' },
    { $set: { status: to, claimToken: null, claimedAt: null, ...set } },
  );
  const inc: Record<string, number> = { ...moveStats('queued', to) };
  if (to === 'skipped' && typeof set.skipReason === 'string')
    inc[`stats.skippedBy.${set.skipReason}`] = 1;
  await CampaignModel.updateOne({ _id: campaign._id }, { $inc: inc });
};

/**
 * The agent's next call: a human call to the next dialable contact, with the agent's media
 * ticket — or why there is nothing to dial right now.
 */
export const nextTeamCall = async (req: Request, id: string, deps: TeamDeps) => {
  const { accountId, userId } = agentOf(req);
  const campaign = await teamCampaign(accountId, id, userId);
  const slot = await readSlot(id, userId);
  if (!slot) throw new AppError('AGENT_SESSION_GONE');
  const live = await CallModel.findOne({
    accountId,
    agentUserId: new Types.ObjectId(userId),
    status: { $in: ['queued', 'ringing', 'in_progress'] },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }>();
  if (live) throw new AppError('AGENT_CALL_ACTIVE');
  if (campaign.status !== 'running' || !campaign.snapshot.done) return wait('not_running');
  const now = new Date();
  const account = await accountFacts(accountId);
  const window = effectiveWindow({
    account: account.window,
    campaign: campaign.window,
    live: true,
    recovery: false,
  });
  if (!window) return wait('window');
  if (!canDialAt(now, window, campaign.schedule.timezone))
    return wait('window', nextWindowStart(now, window, campaign.schedule.timezone));
  if ((await virtualRoom(campaign)) <= 0) return wait('wallet');
  const line = campaign.line === 'whatsapp' ? 'whatsapp' : 'phone';
  if (line === 'phone' && (account.line !== 'sip' || !deps.manager)) return wait('line');
  if (line === 'whatsapp') {
    if (!deps.whatsappCalls || !campaign.channelId) return wait('line');
    if (!(await validateWhatsAppLine(accountId, campaign.channelId).catch(() => null)))
      return wait('line');
  }
  for (let skips = 0; skips < MAX_SKIPS_PER_REQUEST; skips += 1) {
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
      return wait('no_contacts');
    }
    await CampaignModel.updateOne({ _id: campaign._id }, { $inc: moveStats(cc.status, 'queued') });
    const facts = await loadContactFacts({
      accountId: accountId.toString(),
      contactId: cc.contactId.toString(),
      phone: cc.phoneE164,
      mode: 'live',
      now,
      timezone: campaign.schedule.timezone,
      minGapMinutes: account.caps.minGapMinutes,
    });
    const decision = decideDial({
      now,
      accountStatus: account.status,
      campaignStatus: 'running',
      window,
      timezone: campaign.schedule.timezone,
      endAt: campaign.schedule.endAt,
      ...facts,
      caps: account.caps,
      money: 'ok',
    });
    if (decision.kind === 'skip') {
      await settle(campaign, cc, 'skipped', { skipReason: decision.reason, nextAttemptAt: null });
      continue;
    }
    if (decision.kind === 'wait') {
      await settle(campaign, cc, cc.status, {
        nextAttemptAt: decision.until,
        waitReason: decision.reason,
      });
      continue;
    }
    if (decision.kind !== 'dial') {
      await settle(campaign, cc, cc.status, {});
      return wait('busy');
    }
    if (line === 'whatsapp' && campaign.channelId) {
      const allowed = await allowedCallContacts(accountId, campaign.channelId, [cc.contactId], now);
      if (!allowed.has(cc.contactId.toString())) {
        await settle(campaign, cc, 'skipped', {
          skipReason: 'no_call_permission',
          nextAttemptAt: null,
        });
        continue;
      }
    }
    const attempt = Math.max(cc.dials ?? 0, cc.attempts) + 1;
    let callId: string;
    let ticket: { mediaTicket: string; expiresAt: string; wsPath: string };
    try {
      if (line === 'phone' && deps.manager) {
        const caller = await resolveCallerId(
          accountId,
          campaign.phoneLine?.callerNumberId ?? null,
        ).catch(() => resolveCallerId(accountId, null));
        const out = await deps.manager.startOutboundCall({
          accountId: accountId.toString(),
          mode: 'human',
          provider: 'sip',
          callerId: caller?.number ?? null,
          to: cc.phoneE164,
          contactId: cc.contactId.toString(),
          source: { kind: null },
          variables: cc.variables,
          campaign: { campaignId: id, campaignContactId: cc._id.toString(), attempt },
          initiatedBy: userId,
          groupLimit: account.limits.maxConcurrentCalls,
        });
        callId = out.callId;
        ticket = await issueMediaTicket({ userId, accountId: accountId.toString(), callId });
      } else {
        const out = (await deps.whatsappCalls?.startOutbound(
          {
            type: 'user',
            id: new Types.ObjectId(userId),
            accountId,
            userId: new Types.ObjectId(userId),
          },
          {
            channelId: (campaign.channelId as Types.ObjectId).toString(),
            contactId: cc.contactId.toString(),
            mode: 'human',
            campaign: { campaignId: id, campaignContactId: cc._id.toString(), attempt },
          },
        )) as { callId: string; mediaTicket?: string; expiresAt?: string; wsPath?: string };
        callId = out.callId;
        ticket = out.mediaTicket
          ? {
              mediaTicket: out.mediaTicket,
              expiresAt: out.expiresAt ?? '',
              wsPath: out.wsPath ?? '',
            }
          : await issueMediaTicket({ userId, accountId: accountId.toString(), callId });
      }
    } catch (err) {
      await settle(campaign, cc, cc.status, {});
      if (err instanceof AppError && err.code === 'NUMBER_NOT_ALLOWED') {
        await CampaignContactModel.updateOne(
          { _id: cc._id },
          { $set: { status: 'skipped', skipReason: 'number_not_allowed' } },
        );
        continue;
      }
      throw err;
    }
    await CampaignContactModel.updateOne(
      { _id: cc._id },
      {
        $set: {
          status: 'calling',
          lastCallId: new Types.ObjectId(callId),
          lastAttemptAt: now,
          dials: attempt,
          waitReason: null,
          agentUserId: new Types.ObjectId(userId),
        },
        $inc: { attempts: 1 },
      },
    );
    await CampaignModel.updateOne(
      { _id: campaign._id },
      { $inc: { ...moveStats('queued', 'calling'), 'stats.attempts': 1 } },
    );
    await writeSlot(id, userId, slotOf('on_call', { callId }));
    publishSession(campaign);
    publishProgress(id);
    const contact = await ContactModel.findOne({ _id: cc.contactId, accountId })
      .select({ name: 1 })
      .lean<{ name: string | null }>();
    return {
      kind: 'call' as const,
      callId,
      transport: line === 'whatsapp' ? ('whatsapp' as const) : ('sip' as const),
      contact: { id: cc.contactId.toString(), name: contact?.name ?? null },
      ...ticket,
    };
  }
  return wait('busy');
};

/**
 * After the call: the agent's outcome and note (optional) on the call and the contact, then
 * the agent is ready again. While the result is not applied yet (the call just ended), only
 * the call gets the outcome: applying the result counts it once.
 */
export const wrapUpCall = async (
  req: Request,
  id: string,
  callId: string,
  body: { disposition?: string | null | undefined; note?: string | null | undefined },
) => {
  const { accountId, userId } = agentOf(req);
  const campaign = await teamCampaign(accountId, id, userId);
  const call = Types.ObjectId.isValid(callId)
    ? await CallModel.findOne({ _id: callId, accountId, campaignId: campaign._id }).lean<CallDoc>()
    : null;
  if (!call) throw new NotFoundError('Call not found');
  if (call.agentUserId?.toString() !== userId) throw new ForbiddenError();
  if (['queued', 'ringing', 'in_progress'].includes(call.status))
    throw new AppError('AGENT_CALL_ACTIVE', 'Hang up first, then save the outcome.');
  const disposition = body.disposition?.trim() || null;
  const note = body.note?.trim() || null;
  if (disposition) {
    const account = await AccountModel.findById(accountId)
      .select({ settings: 1 })
      .lean<AccountDoc>();
    const allowed = account ? dispositionsOf(account).filter((d) => d.active) : [];
    if (!allowed.some((d) => d.key === disposition)) throw new AppError('DISPOSITION_UNKNOWN');
  }
  if (disposition || note) {
    await CallModel.updateOne(
      { _id: call._id },
      {
        $set: {
          ...(disposition ? { disposition, dispositionSource: 'user' } : {}),
          ...(note ? { 'outcome.agentNote': note.slice(0, 2000) } : {}),
        },
      },
    );
  }
  if (disposition && call.campaignContactId) {
    // applied already (contact left `calling` for this call): move the count by hand
    const before = await CampaignContactModel.findOneAndUpdate(
      {
        _id: call.campaignContactId,
        accountId,
        $nor: [{ status: 'calling', lastCallId: call._id }],
      },
      { $set: { disposition } },
      { returnDocument: 'before' },
    ).lean<CampaignContactDoc>();
    if (before && before.disposition !== disposition) {
      await CampaignModel.updateOne(
        { _id: campaign._id },
        {
          $inc: {
            [`stats.dispositions.${disposition}`]: 1,
            ...(before.disposition ? { [`stats.dispositions.${before.disposition}`]: -1 } : {}),
          },
        },
      );
    }
    if (call.contactId)
      await ContactModel.updateOne(
        { _id: call.contactId, accountId },
        { $set: { lastDisposition: disposition } },
      );
  }
  if (disposition || note)
    await auditRequest(req, 'call.disposition_updated', {
      target: { type: 'call', id: call._id.toString() },
      meta: { from: call.disposition, to: disposition, campaignId: id },
    });
  const slot = await readSlot(id, userId);
  if (slot && slot.state !== 'on_call') await writeSlot(id, userId, slotOf('ready'));
  publishSession(campaign);
  publishProgress(id);
  return { callId, disposition: disposition ?? call.disposition ?? null };
};

/**
 * A team call ended (any process that owns calls): the agent goes to wrap-up for the
 * campaign's wrap-up time.
 */
export const teamCallEnded = async (
  call: Pick<CallDoc, '_id' | 'campaignId' | 'agentUserId' | 'endReason'>,
) => {
  if (!call.campaignId || !call.agentUserId) return;
  const campaign = await CampaignModel.findById(call.campaignId)
    .select({ talkMode: 1, team: 1, accountId: 1 })
    .lean<CampaignDoc>();
  if (campaign?.talkMode !== 'team') return;
  const id = campaign._id.toString();
  const userId = call.agentUserId.toString();
  const slot = await readSlot(id, userId);
  if (!slot || slot.callId !== call._id.toString()) return;
  if (call.endReason === 'no_agent_available') {
    // the agent's browser never joined the call: no more calls until they come back
    await writeSlot(id, userId, slotOf('paused', { seenAt: slot.seenAt }));
    publishSession(campaign);
    return;
  }
  const wrap = (campaign.team?.wrapUpSec ?? 0) * 1000;
  await writeSlot(id, userId, {
    ...slot,
    state: wrap > 0 ? 'wrap_up' : 'ready',
    since: Date.now(),
    until: wrap > 0 ? Date.now() + wrap : null,
  });
  publishSession(campaign);
};

/**
 * CM (D17): per-agent results of a campaign — calls, connected, talk time and outcomes for
 * each member who talked; the AI's calls in one row (`userId: null`).
 */
export const campaignAgentStats = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const campaign = Types.ObjectId.isValid(id)
    ? await CampaignModel.findOne({ _id: id, accountId, deletedAt: null })
        .select({ _id: 1 })
        .lean<{ _id: Types.ObjectId }>()
    : null;
  if (!campaign) throw new NotFoundError('Campaign not found');
  const rows = await CallModel.aggregate<{
    _id: { user: Types.ObjectId | null; disposition: string | null };
    calls: number;
    connected: number;
    talkSec: number;
  }>([
    { $match: { accountId, campaignId: campaign._id } },
    {
      $group: {
        _id: {
          user: { $cond: [{ $eq: ['$mode', 'human'] }, '$agentUserId', null] },
          disposition: '$disposition',
        },
        calls: { $sum: 1 },
        connected: { $sum: { $cond: [{ $ne: ['$timestamps.answeredAt', null] }, 1, 0] } },
        talkSec: { $sum: '$durationSec' },
      },
    },
  ]);
  const byUser = new Map<
    string,
    { calls: number; connected: number; talkSec: number; outcomes: Record<string, number> }
  >();
  for (const r of rows) {
    const key = r._id.user?.toString() ?? '';
    const cur = byUser.get(key) ?? { calls: 0, connected: 0, talkSec: 0, outcomes: {} };
    cur.calls += r.calls;
    cur.connected += r.connected;
    cur.talkSec += r.talkSec;
    if (r._id.disposition)
      cur.outcomes[r._id.disposition] = (cur.outcomes[r._id.disposition] ?? 0) + r.calls;
    byUser.set(key, cur);
  }
  const ids = [...byUser.keys()].filter((k) => k && Types.ObjectId.isValid(k));
  const users = await UserModel.find({ accountId, _id: { $in: ids } })
    .select({ name: 1 })
    .lean<{ _id: Types.ObjectId; name: string }[]>();
  const names = new Map(users.map((u) => [u._id.toString(), u.name]));
  return [...byUser.entries()]
    .map(([userId, s]) => ({
      userId: userId || null,
      name: userId ? (names.get(userId) ?? 'Team member') : 'AI',
      calls: s.calls,
      connected: s.connected,
      talkSec: Math.round(s.talkSec),
      outcomes: s.outcomes,
    }))
    .sort((a, b) => b.calls - a.calls);
};
