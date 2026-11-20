import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { CallModel } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { WhatsAppScheduledCallModel } from '../../src/db/models/whatsapp-scheduled-call.model';
import type { CallEndedSummary } from '../../src/modules/calls/session';
import { createScheduledCalls } from '../../src/modules/whatsapp-calling/scheduled.service';
import { createLogger } from '../../src/shared/logger';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { createAgentDoc } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';

/** SAC-T9: an AI agent's `schedule_callback` on a WhatsApp call becomes a scheduled AI call. */
useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const clock = new Date('2026-11-21T04:00:00.000Z'); // 09:30 IST

let users: Awaited<ReturnType<typeof world.setup>>['users'];
const svc = () =>
  createScheduledCalls({ logger, calls: null, permissions: null, now: () => clock });

const aiCall = async (agentId: string, over: Record<string, unknown> = {}) => {
  const contact = await ContactModel.create({
    accountId: state.acc.account._id,
    phoneE164: `+9190001${String(Math.floor(Math.random() * 90_000) + 10_000)}`,
    source: { type: 'manual' },
  });
  const call = await CallModel.create({
    accountId: state.acc.account._id,
    direction: 'outbound',
    provider: 'whatsapp',
    mode: 'ai',
    from: `whatsapp:${state.channel._id.toString()}`,
    to: contact.phoneE164,
    contactId: contact._id,
    startedBy: users.owner.user._id,
    source: { kind: 'agent', agentId: new Types.ObjectId(agentId) },
    timestamps: { queuedAt: clock },
    whatsapp: {
      channelId: state.channel._id,
      waCallId: null,
      direction: 'BUSINESS_INITIATED',
      conversationId: null,
    },
    ...over,
  } as never);
  return { callId: call._id.toString(), contactId: contact._id };
};
const summary = (callId: string, callback: unknown): CallEndedSummary => ({
  callId,
  accountId: state.acc.account._id.toString(),
  status: 'completed',
  endReason: 'agent_end_call',
  durationSec: 60,
  costMicros: 0,
  disposition: 'callback',
  outcome: { callback },
});

beforeEach(async () => {
  ({ users } = await world.setup());
});

describe('AI callback → scheduled call (SAC-T9)', () => {
  it('the agent with the tool on: a scheduled AI call at the asked time, same program, once', async () => {
    const agentId = await createAgentDoc(state.acc.account._id, 'Callback agent');
    await AiAgentModel.updateOne(
      { _id: agentId },
      { $set: { 'builtInTools.scheduleCallback': { enabled: true, maxDaysAhead: 7 } } },
    );
    const { callId, contactId } = await aiCall(agentId);
    const s = svc();
    await s.onCallEnded(summary(callId, { date: '2026-11-22', time: '15:30' }));
    await s.onCallEnded(summary(callId, { date: '2026-11-22', time: '15:30' }));
    const rows = await WhatsAppScheduledCallModel.find({ contactId }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin: 'ai_callback', status: 'scheduled' });
    expect(rows[0]?.program.id.toString()).toBe(agentId);
    // 15:30 IST = 10:00 UTC
    expect(rows[0]?.dueAt.toISOString()).toBe('2026-11-22T10:00:00.000Z');
  });

  it('no time said → 11:00 in the account timezone', async () => {
    const agentId = await createAgentDoc(state.acc.account._id, 'No time');
    await AiAgentModel.updateOne(
      { _id: agentId },
      { $set: { 'builtInTools.scheduleCallback': { enabled: true, maxDaysAhead: 7 } } },
    );
    const { callId, contactId } = await aiCall(agentId);
    await svc().onCallEnded(summary(callId, { date: '2026-11-23', time: null }));
    const row = await WhatsAppScheduledCallModel.findOne({ contactId }).lean();
    expect(row?.dueAt.toISOString()).toBe('2026-11-23T05:30:00.000Z');
  });

  it('nothing when the tool is off, the date is bad, or the call is not a WhatsApp AI call', async () => {
    const off = await createAgentDoc(state.acc.account._id, 'Tool off');
    const a = await aiCall(off);
    await svc().onCallEnded(summary(a.callId, { date: '2026-11-22', time: '10:00' }));
    const onAgent = await createAgentDoc(state.acc.account._id, 'Tool on');
    await AiAgentModel.updateOne(
      { _id: onAgent },
      { $set: { 'builtInTools.scheduleCallback': { enabled: true, maxDaysAhead: 7 } } },
    );
    const b = await aiCall(onAgent);
    await svc().onCallEnded(summary(b.callId, { date: 'tomorrow' }));
    const c = await aiCall(onAgent, { provider: 'sip' });
    await svc().onCallEnded(summary(c.callId, { date: '2026-11-22', time: '10:00' }));
    expect(
      await WhatsAppScheduledCallModel.countDocuments({
        contactId: { $in: [a.contactId, b.contactId, c.contactId] },
      }),
    ).toBe(0);
  });
});
