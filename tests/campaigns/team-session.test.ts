import type { Request } from 'express';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel } from '../../src/db/models/call.model';
import { CampaignContactModel } from '../../src/db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../src/db/models/campaign.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import type { CallManager } from '../../src/modules/calls/call.service';
import {
  createCampaign,
  startCampaign,
  updateCampaign,
} from '../../src/modules/campaigns/campaigns.service';
import { setSessionRedis } from '../../src/modules/campaigns/team/session';
import {
  campaignAgentStats,
  joinSession,
  leaveSession,
  nextTeamCall,
  sessionOf,
  updateSession,
  wrapUpCall,
} from '../../src/modules/campaigns/team/team.service';
import { teamCallFinished } from '../../src/modules/campaigns/team/wire';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard, fund } from '../helpers/calls';
import { ALL_DAY } from '../helpers/campaigns';
import { useTestDb } from '../helpers/db';
import { requireRedis } from '../helpers/redis';

// the install has a SIP trunk for this account (no Asterisk in tests)
vi.mock('../../src/modules/calls/line', () => ({ effectiveLine: () => 'sip' }));
vi.mock('../../src/modules/calls/media-tickets', () => ({
  issueMediaTicket: () =>
    Promise.resolve({
      mediaTicket: 'wst_team',
      expiresAt: new Date().toISOString(),
      wsPath: '/ws/media',
    }),
}));

/** CM — team calling: agents join, take the next contact, wrap up; no AI on the call. */

useTestDb();
let redis: Redis;
let t: TestAccount;
let owner: TestUser;
let caller: TestUser;
let outsider: TestUser;
let listId: string;

const reqOf = (u: TestUser) =>
  ({
    auth: {
      kind: 'user',
      accountId: t.account._id.toString(),
      userId: u.user._id.toString(),
      roleKey: 'owner',
      permissions: new Set<string>(),
      account: {
        id: t.account._id.toString(),
        status: 'active',
        timezone: 'Asia/Kolkata',
        isPlatform: false,
      },
    },
    ip: '127.0.0.1',
  }) as unknown as Request;

const started: Record<string, unknown>[] = [];
const manager = {
  startOutboundCall: async (input: Record<string, unknown>) => {
    started.push(input);
    const campaign = input.campaign as {
      campaignId: string;
      campaignContactId: string;
      attempt: number;
    };
    const call = await CallModel.create({
      accountId: new Types.ObjectId(input.accountId as string),
      contactId: new Types.ObjectId(input.contactId as string),
      direction: 'outbound',
      provider: 'dryrun',
      mode: 'human',
      from: 'x',
      to: input.to as string,
      isTest: false,
      source: { kind: null },
      agentUserId: new Types.ObjectId(input.initiatedBy as string),
      campaignId: new Types.ObjectId(campaign.campaignId),
      campaignContactId: new Types.ObjectId(campaign.campaignContactId),
      attempt: campaign.attempt,
      status: 'in_progress',
      timestamps: { queuedAt: new Date(), answeredAt: new Date() },
    });
    return { callId: call._id.toString() };
  },
} as unknown as CallManager;

const endCall = async (callId: string, endReason = 'customer_hangup') => {
  await CallModel.updateOne(
    { _id: callId },
    { $set: { status: 'completed', endReason, 'timestamps.endedAt': new Date() } },
  );
  await teamCallFinished({ callId });
};

beforeAll(async () => {
  redis = (await requireRedis()).client;
  setSessionRedis(redis);
  await ensureRateCard();
  t = await createTestAccount({ name: 'Team Co' });
  owner = await t.addUser('owner');
  caller = await t.addUser('agent');
  outsider = await t.addUser('agent');
  await fund(t.account._id, 2_000_000_000);
  await AccountModel.updateOne(
    { _id: t.account._id },
    {
      'settings.callingWindow': ALL_DAY,
      'settings.callCaps': { perDay: 10, perWeek: 50, minGapMinutes: 0 },
    },
  );
  const list = await ContactListModel.create({
    accountId: t.account._id,
    name: 'Team list',
    source: { type: 'manual' },
  });
  listId = list._id.toString();
  for (let i = 1; i <= 2; i += 1)
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: `+91900077000${String(i)}`,
      name: `Team ${String(i)}`,
      source: { type: 'manual' },
      listIds: [list._id],
    });
});
afterAll(() => setSessionRedis(null));

describe('team calling campaigns', () => {
  it('settings: team needs a live phone / WhatsApp campaign, no AI program, active agents', async () => {
    const c = await createCampaign(reqOf(owner), {
      name: 'Team draft',
      mode: 'live',
      talkMode: 'team',
      team: { agentUserIds: [caller.user._id.toString()], wrapUpSec: 0 },
      window: ALL_DAY,
      audience: { listIds: [listId] },
    } as never);
    expect(c).toMatchObject({ talkMode: 'team', team: { wrapUpSec: 0 } });
    const doc = (await CampaignModel.findById(c.id).lean<CampaignDoc>())!;
    expect(doc.program ?? null).toBeNull();
    expect(doc.flowId ?? null).toBeNull();
    await expect(
      updateCampaign(reqOf(owner), c.id, {
        revision: doc.revision,
        team: { agentUserIds: [new Types.ObjectId().toString()], wrapUpSec: 0 },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('join → next call (human, the agent owns it) → hang up → wrap-up → next → done', async () => {
    // live calls only inside 09:00–21:00 IST (TRAI): the clock reads noon IST today
    const noon = new Date();
    noon.setUTCHours(6, 30, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: noon });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const c = await createCampaign(reqOf(owner), {
      name: 'Team run',
      mode: 'live',
      talkMode: 'team',
      team: { agentUserIds: [caller.user._id.toString()], wrapUpSec: 0 },
      window: ALL_DAY,
      audience: { listIds: [listId] },
    } as never);
    await startCampaign(reqOf(owner), c.id);
    // the snapshot runs in the background (slow under load): up to 30 s
    for (let i = 0; i < 600; i += 1) {
      const doc = await CampaignModel.findById(c.id).lean<CampaignDoc>();
      if (doc?.snapshot.done) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // only the campaign's own callers
    await expect(joinSession(reqOf(outsider), c.id)).rejects.toMatchObject({
      code: 'AGENT_NOT_IN_CAMPAIGN',
    });
    await expect(nextTeamCall(reqOf(caller), c.id, { manager })).rejects.toMatchObject({
      code: 'AGENT_SESSION_GONE',
    });
    const board = await joinSession(reqOf(caller), c.id);
    expect(board).toMatchObject({ ready: 1, onCall: 0 });
    expect(await AuditLogModel.exists({ action: 'campaign.agent_joined' })).toBeTruthy();

    const first = await nextTeamCall(reqOf(caller), c.id, { manager });
    expect(first).toMatchObject({ kind: 'call', transport: 'sip', mediaTicket: 'wst_team' });
    expect(started[0]).toMatchObject({ mode: 'human', initiatedBy: caller.user._id.toString() });
    if (first.kind !== 'call') throw new Error('no call');
    expect((await sessionOf(reqOf(owner), c.id)).onCall).toBe(1);
    // one call at a time per agent
    await expect(nextTeamCall(reqOf(caller), c.id, { manager })).rejects.toMatchObject({
      code: 'AGENT_CALL_ACTIVE',
    });
    await expect(
      wrapUpCall(reqOf(caller), c.id, first.callId, { disposition: 'paid' }),
    ).rejects.toMatchObject({ code: 'AGENT_CALL_ACTIVE' });

    await endCall(first.callId);
    await expect(
      wrapUpCall(reqOf(caller), c.id, first.callId, { disposition: 'nope' }),
    ).rejects.toMatchObject({ code: 'DISPOSITION_UNKNOWN' });
    await wrapUpCall(reqOf(caller), c.id, first.callId, {
      disposition: 'paid',
      note: 'Paid by UPI',
    });
    const call = await CallModel.findById(first.callId).lean();
    expect(call).toMatchObject({ disposition: 'paid', dispositionSource: 'user' });
    expect((call?.outcome as { agentNote?: string }).agentNote).toBe('Paid by UPI');
    let doc = (await CampaignModel.findById(c.id).lean<CampaignDoc>())!;
    expect(doc.stats.dispositions).toMatchObject({ paid: 1 });
    expect(doc.stats.answered).toBe(1);
    const cc = await CampaignContactModel.findOne({ lastCallId: first.callId }).lean();
    expect(cc).toMatchObject({ disposition: 'paid', agentUserId: caller.user._id });

    // the agent's browser never joined: the contact is called again, the agent paused
    const second = await nextTeamCall(reqOf(caller), c.id, { manager });
    if (second.kind !== 'call') throw new Error('no call');
    await endCall(second.callId, 'no_agent_available');
    const board2 = await sessionOf(reqOf(owner), c.id);
    expect(board2.agents[0]?.state).toBe('paused');
    const again = await CampaignContactModel.findOne({ lastCallId: second.callId }).lean();
    expect(again?.status).not.toBe('calling');
    expect(again?.attempts).toBe(0);
    await updateSession(reqOf(caller), c.id, 'ready');

    const third = await nextTeamCall(reqOf(caller), c.id, { manager });
    if (third.kind !== 'call') throw new Error('no call');
    expect(third.contact.id).toBe(second.contact.id);
    await endCall(third.callId);
    await wrapUpCall(reqOf(caller), c.id, third.callId, {});
    const done = await nextTeamCall(reqOf(caller), c.id, { manager });
    expect(done).toMatchObject({ kind: 'wait' });
    doc = (await CampaignModel.findById(c.id).lean<CampaignDoc>())!;
    expect(doc.status).toBe('completed');
    expect(await leaveSession(reqOf(caller), c.id)).toMatchObject({ agents: [] });
    // who talked: every call was the member's (3 calls, 2 connected-by-hand outcomes one)
    const stats = await campaignAgentStats(reqOf(owner), c.id);
    expect(stats).toEqual([
      expect.objectContaining({
        userId: caller.user._id.toString(),
        calls: 3,
        connected: 3,
        outcomes: { paid: 1 },
      }),
    ]);
  });
});
