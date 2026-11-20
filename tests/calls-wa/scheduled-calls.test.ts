import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { MessageModel } from '../../src/db/models/message.model';
import { NotificationModel } from '../../src/db/models/notification.model';
import { WhatsAppScheduledCallModel } from '../../src/db/models/whatsapp-scheduled-call.model';
import type { CallEndedSummary } from '../../src/modules/calls/session';
import { createCallingRuntime } from '../../src/modules/whatsapp-calling/runtime';
import {
  createScheduledCalls,
  insideCallingWindow,
  resultOf,
  type ScheduledCallsService,
} from '../../src/modules/whatsapp-calling/scheduled.service';
import { AppError } from '../../src/shared/errors/app-error';
import { createLogger } from '../../src/shared/logger';
import { ensureRateCard } from '../helpers/calls';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { createAgentDoc } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';

/** SAC-T8: scheduled AI WhatsApp calls — create, exactly-once dispatch, skips, retries. */
useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const logger = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
const MIN = 60_000;

let users: Awaited<ReturnType<typeof world.setup>>['users'];
let clock = new Date('2026-11-21T04:00:00.000Z'); // 09:30 IST
const now = () => clock;
let ended: ((s: CallEndedSummary) => Promise<void>) | null = null;
const startOutbound = vi.fn();
const fakeCalls = {
  startOutbound,
  onCallEnded: (fn: (s: CallEndedSummary) => Promise<void>) => {
    ended = fn;
    return () => {
      ended = null;
    };
  },
} as never;
let svc: ScheduledCallsService;
let agentId: string;
let contactId: Types.ObjectId;
let conversationId: Types.ObjectId;

const actor = () => ({ accountId: state.acc.account._id, userId: users.owner.user._id });
const schedule = (over: Record<string, unknown> = {}) =>
  svc.create(actor(), {
    channelId: state.channel._id.toString(),
    contactId: contactId.toString(),
    conversationId: conversationId.toString(),
    program: { kind: 'agent', id: agentId },
    purpose: 'EMI reminder',
    dueAt: new Date(clock.getTime() + 30 * MIN),
    ...over,
  });
const row = (id: string) => WhatsAppScheduledCallModel.findById(id).lean();
const summary = (callId: string, over: Partial<CallEndedSummary> = {}): CallEndedSummary => ({
  callId,
  accountId: state.acc.account._id.toString(),
  status: 'completed',
  endReason: 'hangup_node',
  durationSec: 40,
  costMicros: 0,
  disposition: null,
  outcome: {},
  ...over,
});

beforeAll(async () => {
  await ensureRateCard();
});
beforeEach(async () => {
  ({ users } = await world.setup());
  clock = new Date('2026-11-21T04:00:00.000Z');
  startOutbound.mockReset();
  // rows of earlier tests must not be due in this one
  await WhatsAppScheduledCallModel.updateMany(
    { status: 'scheduled' },
    { $set: { status: 'cancelled' } },
  );
  startOutbound.mockImplementation(() =>
    Promise.resolve({ callId: new Types.ObjectId().toString() }),
  );
  svc = createScheduledCalls({ logger, calls: fakeCalls, permissions: null, now });
  svc.start();
  await svc.stop(); // keeps the onCallEnded listener out of the timer: tests drive tick()
  svc.start();
  agentId = (await createAgentDoc(state.acc.account._id, 'Caller')).toString();
  const contact = await ContactModel.create({
    accountId: state.acc.account._id,
    phoneE164: `+9190000${String(Math.floor(Math.random() * 90_000) + 10_000)}`,
    source: { type: 'manual' },
  });
  contactId = contact._id;
  conversationId = (
    await ConversationModel.create({
      accountId: state.acc.account._id,
      channelId: state.channel._id,
      contactId,
      waId: contact.phoneE164.replace(/\D/g, ''),
      phoneE164: contact.phoneE164,
      source: 'outbound',
    } as never)
  )._id;
});

describe('create (SAC-T8)', () => {
  it('saves, writes a chat line and warns about the calling window and the wallet', async () => {
    const r = await schedule({ dueAt: new Date('2026-11-21T17:00:00.000Z') }); // 22:30 IST
    expect(r.scheduledCall).toMatchObject({ status: 'scheduled', origin: 'manual', attempt: 0 });
    expect(r.warnings.outsideWindow).toBe(true);
    const line = await MessageModel.findOne({ conversationId, 'system.kind': 'call_scheduled' });
    expect(line).not.toBeNull();
  });

  it('refuses a time too soon / too far and a missing program; at most 3 open per contact', async () => {
    await expect(schedule({ dueAt: new Date(clock.getTime() + MIN) })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      schedule({ dueAt: new Date(clock.getTime() + 31 * 86_400_000) }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      schedule({ program: { kind: 'agent', id: new Types.ObjectId().toString() } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    for (let i = 0; i < 3; i += 1) await schedule();
    await expect(schedule()).rejects.toMatchObject({ code: 'CONFLICT_INVALID_STATE' });
  });

  it('the same Idempotency-Key gives the first answer back', async () => {
    const a = await schedule({ idempotencyKey: 'k-1' });
    const b = await schedule({ idempotencyKey: 'k-1' });
    expect(b.replay).toBe(true);
    expect(b.scheduledCall.id).toBe(a.scheduledCall.id);
  });
});

describe('dispatch (SAC-T8)', () => {
  it('places a due call exactly once, even with two runners at the same time', async () => {
    const { scheduledCall } = await schedule();
    expect(await svc.tick()).toBe(0); // not due yet
    clock = new Date(clock.getTime() + 31 * MIN);
    const other = createScheduledCalls({ logger, calls: fakeCalls, permissions: null, now });
    await Promise.all([svc.tick(), other.tick(), svc.tick()]);
    // earlier tests' rows (other accounts) are due too: count this one's calls
    const mine = startOutbound.mock.calls.filter(
      (c) => (c[1] as { scheduled?: { id: string } }).scheduled?.id === scheduledCall.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]?.[1]).toMatchObject({
      mode: 'ai',
      program: { kind: 'agent', id: agentId },
      scheduled: { id: scheduledCall.id, attempt: 1 },
    });
    expect((await row(scheduledCall.id))?.status).toBe('calling');
  });

  it('a call it may not place is skipped with the reason, a bell and a chat line', async () => {
    startOutbound.mockRejectedValue(
      new AppError('CALL_NOT_ALLOWED', undefined, [{ path: 'call', message: 'dnd' }]),
    );
    const { scheduledCall } = await schedule();
    clock = new Date(clock.getTime() + 31 * MIN);
    await svc.tick();
    expect(await row(scheduledCall.id)).toMatchObject({ status: 'skipped', skipReason: 'dnd' });
    expect(await NotificationModel.countDocuments({ type: 'whatsapp.scheduled_call_failed' })).toBe(
      1,
    );
    expect(
      await MessageModel.countDocuments({ conversationId, 'system.kind': 'call_schedule_skipped' }),
    ).toBe(1);
  });

  it('outside the calling window it moves once to the next opening, then skips', async () => {
    const next = new Date(clock.getTime() + 20 * 3_600_000);
    startOutbound.mockRejectedValue(
      new AppError('CALL_OUTSIDE_WINDOW', undefined, [
        { path: 'window', message: next.toISOString() },
      ]),
    );
    const { scheduledCall } = await schedule();
    clock = new Date(clock.getTime() + 31 * MIN);
    await svc.tick();
    const moved = await row(scheduledCall.id);
    expect(moved).toMatchObject({ status: 'scheduled' });
    expect(moved?.dueAt.toISOString()).toBe(next.toISOString());
    expect(moved?.shiftedAt).not.toBeNull();
    clock = new Date(next.getTime() + MIN);
    await svc.tick();
    expect(await row(scheduledCall.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'outside_window',
    });
  });

  it('a full line puts it back 5 minutes (3 times at most)', async () => {
    startOutbound.mockRejectedValue(new AppError('CALL_CAPACITY'));
    const { scheduledCall } = await schedule();
    clock = new Date(clock.getTime() + 31 * MIN);
    await svc.tick();
    expect(await row(scheduledCall.id)).toMatchObject({ status: 'scheduled', capacityRetries: 1 });
    for (let i = 0; i < 3; i += 1) {
      clock = new Date(clock.getTime() + 6 * MIN);
      await svc.tick();
    }
    expect(await row(scheduledCall.id)).toMatchObject({
      status: 'skipped',
      skipReason: 'capacity',
    });
  });

  it('no answer → retried after the gap; answered → done', async () => {
    const { scheduledCall } = await schedule({ retry: { max: 1, gapMin: 30, on: ['no_answer'] } });
    clock = new Date(clock.getTime() + 31 * MIN);
    await svc.tick();
    const first = startOutbound.mock.results[0]?.value as Promise<{ callId: string }>;
    const { callId } = await first;
    await ended?.(
      summary(callId, { status: 'no_answer', endReason: 'not_answered', durationSec: 0 }),
    );
    const waiting = await row(scheduledCall.id);
    expect(waiting).toMatchObject({ status: 'scheduled', attempt: 1 });
    expect(waiting?.dueAt.getTime()).toBe(clock.getTime() + 30 * MIN);
    clock = new Date(clock.getTime() + 31 * MIN);
    await svc.tick();
    expect(startOutbound.mock.calls[1]?.[1]).toMatchObject({
      scheduled: { id: scheduledCall.id, attempt: 2 },
    });
    const second = await (startOutbound.mock.results[1]?.value as Promise<{ callId: string }>);
    await ended?.(summary(second.callId));
    const done = await row(scheduledCall.id);
    expect(done?.status).toBe('done');
    expect(done?.attempts.map((a) => a.result)).toEqual(['no_answer', 'answered']);
  });

  it('a cancelled call is never placed; only a waiting one can change', async () => {
    const { scheduledCall } = await schedule();
    await svc.update(actor(), scheduledCall.id, { purpose: 'Changed' });
    await svc.cancel(actor(), scheduledCall.id);
    await expect(svc.cancel(actor(), scheduledCall.id)).rejects.toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
    });
    await expect(svc.update(actor(), scheduledCall.id, { purpose: 'Again' })).rejects.toMatchObject(
      { code: 'CONFLICT_INVALID_STATE' },
    );
    clock = new Date(clock.getTime() + 31 * MIN);
    await svc.tick();
    expect(startOutbound).not.toHaveBeenCalled();
  });

  it('a claim left by a crashed runner goes back after 10 minutes', async () => {
    const { scheduledCall } = await schedule();
    await WhatsAppScheduledCallModel.updateOne(
      { _id: scheduledCall.id },
      { $set: { status: 'dispatching', claimedAt: new Date(clock.getTime() - 11 * MIN) } },
    );
    clock = new Date(clock.getTime() + 31 * MIN);
    await svc.tick();
    expect(startOutbound).toHaveBeenCalledTimes(1);
  });

  it('helpers: the TRAI window and call results', () => {
    expect(insideCallingWindow(new Date('2026-11-21T04:00:00Z'), 'Asia/Kolkata')).toBe(true);
    expect(insideCallingWindow(new Date('2026-11-21T16:00:00Z'), 'Asia/Kolkata')).toBe(false);
    expect(resultOf({ status: 'busy', endReason: 'busy', durationSec: 0 })).toBe('busy');
    expect(resultOf({ status: 'failed', endReason: 'meta_failed', durationSec: 0 })).toBe('failed');
  });
});

describe('HTTP (SAC-T8)', () => {
  it('owners schedule, viewers only read, other accounts see nothing', async () => {
    const runtime = createCallingRuntime({
      ctx: world.w.ctx,
      service: world.w.svc,
      inbox: state.ix,
    });
    const app = buildTestApp(
      {},
      {
        whatsapp: {
          ctx: world.w.ctx,
          jobs: { enqueueEvent: () => Promise.resolve() },
          inboxJobs: world.jobs,
          storage: world.storage,
          calling: runtime,
        },
      },
    );
    const body = {
      channelId: state.channel._id.toString(),
      contactId: contactId.toString(),
      program: { kind: 'agent', id: agentId },
      dueAt: new Date(Date.now() + 60 * MIN).toISOString(),
    };
    const viewer = await request(app)
      .post('/api/v1/whatsapp/scheduled-calls')
      .set('Authorization', `Bearer ${users.viewer.token}`)
      .send(body);
    expect(viewer.status).toBe(403);
    const made = await request(app)
      .post('/api/v1/whatsapp/scheduled-calls')
      .set('Authorization', `Bearer ${users.owner.token}`)
      .send(body);
    expect(made.status).toBe(201);
    const id = made.body.data.scheduledCall.id as string;
    const list = await request(app)
      .get('/api/v1/whatsapp/scheduled-calls?status=open')
      .set('Authorization', `Bearer ${users.viewer.token}`);
    expect(list.body.data.map((r: { id: string }) => r.id)).toContain(id);
    const cancel = await request(app)
      .post(`/api/v1/whatsapp/scheduled-calls/${id}/cancel`)
      .set('Authorization', `Bearer ${users.owner.token}`);
    expect(cancel.body.data.status).toBe('cancelled');
    const { users: others } = await world.setup();
    const foreign = await request(app)
      .get(`/api/v1/whatsapp/scheduled-calls/${id}`)
      .set('Authorization', `Bearer ${others.owner.token}`);
    expect(foreign.status).toBe(404);
  });
});
