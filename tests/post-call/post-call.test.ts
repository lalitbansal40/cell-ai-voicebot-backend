import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FlowGraphSchema } from '../../src/core/engine/schema';
import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallInsightModel } from '../../src/db/models/call-insight.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { MessageModel } from '../../src/db/models/message.model';
import { OutcomeRuleModel } from '../../src/db/models/outcome-rule.model';
import { PostCallMessageModel } from '../../src/db/models/post-call-message.model';
import { WalletModel } from '../../src/db/models/wallet.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { finishInsights, sweepInsights } from '../../src/modules/insights/insights.service';
import { collectFlowMessages } from '../../src/modules/post-call/collect';
import { evaluateOutcomeRules } from '../../src/modules/post-call/evaluate';
import { whatsappStepIssues } from '../../src/modules/post-call/flow-templates';
import { recordingPostCallJobs, setPostCallJobs } from '../../src/modules/post-call/jobs';
import { processPostCallSend } from '../../src/modules/post-call/send.job';
import { nextWindowHour, scheduledAtFor } from '../../src/modules/post-call/timing';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import * as logger from '../../src/shared/logger';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { useCapturedEmail } from '../helpers/email';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';
import { userActor } from '../helpers/whatsapp';

useTestDb();
useCapturedEmail();
const world = useInboxWorld();
const { state } = world;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const app = () =>
  buildTestApp(
    {},
    {
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
      },
    },
  );

let users: Awaited<ReturnType<typeof world.setup>>['users'];
let jobs = recordingPostCallJobs();
let templateId: string;
let templateName: string;
let n = 0;

beforeEach(async () => {
  jobs = recordingPostCallJobs();
  setPostCallJobs(jobs);
  ({ users } = await world.setup());
  templateName = `pc_${randomUUID().slice(0, 6)}_instant`;
  const t = await createTemplate(
    { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage },
    state.acc.account._id,
    userActor(users.owner.user._id),
    {
      channelId: state.channel._id.toString(),
      name: templateName,
      language: 'en',
      category: 'UTILITY',
      components: [
        {
          type: 'BODY',
          text: 'Hi {{1}}, pay {{2}} by {{3}}.',
          example: { body_text: [['A', 'B', 'C']] },
        },
      ],
    },
  );
  templateId = t.id;
  await WhatsAppTemplateModel.updateOne({ _id: templateId }, { $set: { status: 'APPROVED' } });
  await AccountModel.updateOne(
    { _id: state.acc.account._id },
    { 'settings.callingWindow': { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] } },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const contact = (over: Record<string, unknown> = {}) => {
  n += 1;
  return ContactModel.create({
    accountId: state.acc.account._id,
    phoneE164: `+9190011${String(Date.now()).slice(-3)}${String(n).padStart(2, '0')}`,
    name: 'Asha Verma',
    source: { type: 'manual' },
    ...over,
  });
};

const endedCall = async (over: Record<string, unknown> = {}, who?: { _id: Types.ObjectId }) => {
  const c = who ?? (await contact());
  return CallModel.create({
    accountId: state.acc.account._id,
    direction: 'outbound',
    provider: 'dryrun',
    from: 'dryrun',
    to: '+919000000000',
    status: 'completed',
    endReason: 'hangup_node',
    isTest: true,
    charged: false,
    contactId: c._id,
    externalRef: 'loan-5',
    source: { kind: 'flow', flowId: new Types.ObjectId() },
    timestamps: { queuedAt: new Date(), answeredAt: new Date(), endedAt: new Date() },
    durationSec: 40,
    disposition: 'promise_to_pay',
    variables: { due_date: '2026-11-05' },
    metrics: emptyCallMetrics(),
    cost: emptyCallCost(),
    ...over,
  });
};

const flowMessage = (over: Record<string, unknown> = {}) => ({
  channel: 'whatsapp',
  nodeId: 'wa1',
  text: null,
  templateName,
  language: 'en',
  params: ['Asha', '₹2,500', '5 Nov'],
  dltTemplateId: null,
  channelId: null,
  queuedAt: new Date().toISOString(),
  ...over,
});

const rule = (over: Record<string, unknown> = {}) =>
  OutcomeRuleModel.create({
    accountId: state.acc.account._id,
    name: 'Payment reminder',
    when: {
      dispositions: ['promise_to_pay'],
      sentiment: [],
      hasPromise: null,
      notAnsweredInARow: null,
      callKinds: [],
      flowIds: [],
      campaignIds: [],
    },
    send: {
      channelId: null,
      templateId: new Types.ObjectId(templateId),
      params: [
        { from: 'contact', key: 'name', value: null },
        { from: 'insights', key: 'promise_amount', value: null },
        { from: 'call', key: 'due_date', value: null },
      ],
    },
    timing: { mode: 'now', delayMinutes: null },
    ...over,
  });

const send = async (id: string) => processPostCallSend(state.ix, id);

describe('flow "Send WhatsApp" step', () => {
  it('sends the template after the call: origin system, the call externalRef, charged, in the inbox', async () => {
    const call = await endedCall({
      outcome: { messages: [flowMessage(), { ...flowMessage(), channel: 'sms', nodeId: 's1' }] },
    });
    expect(await collectFlowMessages(call._id.toString())).toBe(1);
    expect(await collectFlowMessages(call._id.toString())).toBe(0); // settle retry
    const [row] = await PostCallMessageModel.find({ callId: call._id }).lean();
    expect(row).toMatchObject({ source: 'flow:wa1', status: 'scheduled', templateName });
    expect(row?.variables).toEqual({ '1': 'Asha', '2': '₹2,500', '3': '5 Nov' });
    expect(jobs.queued).toEqual([{ id: row?._id.toString(), delayMs: 0 }]);
    expect(await send(row?._id.toString() ?? '')).toEqual({ status: 'sent' });
    expect(await send(row?._id.toString() ?? '')).toEqual({ status: 'done' }); // job retry
    const after = await PostCallMessageModel.findById(row?._id).lean();
    const msg = await MessageModel.findById(after?.messageId).lean();
    expect(msg).toMatchObject({
      origin: 'system',
      type: 'template',
      externalRef: 'loan-5',
      sentBy: null,
    });
    expect(msg?.billing?.status).toBe('held');
    expect(
      await MessageModel.countDocuments({ accountId: state.acc.account._id, origin: 'system' }),
    ).toBe(1);

    const view = await request(app())
      .get(`/api/v1/calls/${call._id.toString()}/after-call`)
      .set(bearer(users.owner.token));
    expect(view.status).toBe(200);
    expect(view.body.data).toEqual([
      expect.objectContaining({
        source: 'flow',
        nodeId: 'wa1',
        status: 'sent',
        templateName,
        conversationId: msg?.conversationId.toString(),
      }),
    ]);
  });

  it('a call without a contact is not eligible', async () => {
    const call = await endedCall({ contactId: null, outcome: { messages: [flowMessage()] } });
    await collectFlowMessages(call._id.toString());
    expect(await PostCallMessageModel.findOne({ callId: call._id }).lean()).toMatchObject({
      status: 'skipped',
      reason: 'call_not_eligible',
    });
    expect(jobs.queued).toHaveLength(0);
  });
});

describe('outcome rules', () => {
  it('fire once per call with values from the contact, the call and the insights', async () => {
    const r = await rule();
    const call = await endedCall({
      insights: {
        status: 'done',
        version: 1,
        reason: null,
        sentiment: 'positive',
        hasPromise: true,
        promiseAmountMicros: 2_500_000_000,
        hasSummary: true,
        at: new Date(),
      },
    });
    await CallInsightModel.create({
      accountId: state.acc.account._id,
      callId: call._id,
      version: 1,
      status: 'done',
      output: {
        summary: 's',
        suggestedDisposition: null,
        sentiment: { label: 'positive', score: 1 },
        keyInfo: {
          promiseDate: '2026-11-05',
          promiseAmountMicros: 2_500_000_000,
          callbackAt: null,
          disputeReason: null,
          wrongNumber: false,
          languagePreference: null,
          notes: null,
        },
        confidence: { disposition: 1, promise: 1, sentiment: 1 },
      },
    });
    const [a, b] = await Promise.all([
      evaluateOutcomeRules(call._id),
      evaluateOutcomeRules(call._id),
    ]);
    expect(a + b).toBe(1);
    const rows = await PostCallMessageModel.find({ callId: call._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: `rule:${r._id.toString()}`, ruleId: r._id });
    expect(rows[0]?.variables).toEqual({ '1': 'Asha Verma', '2': '₹2,500', '3': '2026-11-05' });
  });

  it('match only what the "when" asks (outcome, sentiment, promise, kind, flow, not answered N times)', async () => {
    await rule({
      when: {
        dispositions: ['callback'],
        sentiment: [],
        hasPromise: null,
        notAnsweredInARow: null,
        callKinds: [],
        flowIds: [],
        campaignIds: [],
      },
    });
    await rule({
      name: 'neg',
      when: {
        dispositions: [],
        sentiment: ['negative'],
        hasPromise: null,
        notAnsweredInARow: null,
        callKinds: [],
        flowIds: [],
        campaignIds: [],
      },
    });
    await rule({
      name: 'wa only',
      when: {
        dispositions: [],
        sentiment: [],
        hasPromise: null,
        notAnsweredInARow: null,
        callKinds: ['whatsapp'],
        flowIds: [],
        campaignIds: [],
      },
    });
    await rule({
      name: 'other flow',
      when: {
        dispositions: [],
        sentiment: [],
        hasPromise: null,
        notAnsweredInARow: null,
        callKinds: [],
        flowIds: [new Types.ObjectId()],
        campaignIds: [],
      },
    });
    await rule({
      name: 'campaign',
      when: {
        dispositions: [],
        sentiment: [],
        hasPromise: null,
        notAnsweredInARow: null,
        callKinds: [],
        flowIds: [],
        campaignIds: [new Types.ObjectId()],
      },
    });
    await rule({
      name: 'promise',
      when: {
        dispositions: [],
        sentiment: [],
        hasPromise: true,
        notAnsweredInARow: null,
        callKinds: [],
        flowIds: [],
        campaignIds: [],
      },
    });
    const call = await endedCall();
    expect(await evaluateOutcomeRules(call._id)).toBe(0);

    const missed = await rule({
      name: 'missed twice',
      when: {
        dispositions: [],
        sentiment: [],
        hasPromise: null,
        notAnsweredInARow: 2,
        callKinds: ['phone'],
        flowIds: [],
        campaignIds: [],
      },
    });
    const who = await contact();
    const unanswered = {
      status: 'no_answer',
      disposition: null,
      timestamps: { queuedAt: new Date(), endedAt: new Date() },
    };
    const first = await endedCall({ ...unanswered, createdAt: new Date(Date.now() - 60_000) }, who);
    expect(await evaluateOutcomeRules(first._id)).toBe(0);
    const second = await endedCall(unanswered, who);
    expect(await evaluateOutcomeRules(second._id)).toBe(1);
    expect(
      await PostCallMessageModel.exists({ callId: second._id, ruleId: missed._id }),
    ).toBeTruthy();
  });

  it('run when insights finish — also when insights are off (skipped)', async () => {
    await rule({
      when: {
        dispositions: [],
        sentiment: [],
        hasPromise: null,
        notAnsweredInARow: null,
        callKinds: [],
        flowIds: [],
        campaignIds: [],
      },
    });
    const call = await endedCall({
      insights: {
        status: 'pending',
        version: 1,
        reason: null,
        sentiment: null,
        hasPromise: false,
        promiseAmountMicros: null,
        hasSummary: false,
        at: new Date(),
      },
    });
    await finishInsights(call, 1, 'skipped', 'disabled', new Date());
    await vi.waitFor(async () => {
      expect(await PostCallMessageModel.countDocuments({ callId: call._id })).toBe(1);
    });
  });

  it('run when the sweep skips a call: "not answered twice" and calls too short to review', async () => {
    await rule({
      when: {
        dispositions: [],
        sentiment: [],
        hasPromise: null,
        notAnsweredInARow: 2,
        callKinds: [],
        flowIds: [],
        campaignIds: [],
      },
    });
    const who = await contact();
    const missed = {
      status: 'no_answer',
      insights: null,
      timestamps: { queuedAt: new Date(), answeredAt: null, endedAt: new Date() },
    };
    const first = await endedCall(missed, who);
    const second = await endedCall(missed, who);
    const later = new Date(Date.now() + 5 * 60_000);
    await sweepInsights({ jobs: { enqueue: () => Promise.resolve() }, now: () => later } as never);
    await vi.waitFor(async () => {
      expect(await PostCallMessageModel.countDocuments({ callId: second._id })).toBe(1);
    });
    expect((await CallModel.findById(first._id).lean())?.insights).toMatchObject({
      status: 'skipped',
      reason: 'not_answered',
    });
    // the sweep marks a call once, so a second sweep schedules nothing new
    await sweepInsights({ jobs: { enqueue: () => Promise.resolve() }, now: () => later } as never);
    expect(await PostCallMessageModel.countDocuments({ callId: second._id })).toBe(1);
  });
});

describe('send-time checks (exact skip reasons)', () => {
  const scheduled = async (over: Record<string, unknown> = {}, who?: Record<string, unknown>) => {
    const c = await contact(who);
    const call = await endedCall({}, c);
    const row = await PostCallMessageModel.create({
      accountId: state.acc.account._id,
      callId: call._id,
      contactId: c._id,
      source: `flow:${randomUUID().slice(0, 4)}`,
      channelId: state.channel._id,
      templateId: new Types.ObjectId(templateId),
      templateName,
      language: 'en',
      variables: { '1': 'A', '2': 'B', '3': 'C' },
      scheduledAt: new Date(),
      ...over,
    });
    return row._id.toString();
  };

  it.each([
    ['opted_out', {}, { optedOutAt: new Date() }],
    ['dnd', {}, { dnd: true }],
    ['no_template', { templateId: null }, {}],
    ['no_number', { channelId: null }, {}],
    ['no_number', { channelId: new Types.ObjectId() }, {}],
    ['rule_disabled', { ruleId: new Types.ObjectId() }, {}],
  ])('%s', async (reason, over, who) => {
    expect(await send(await scheduled(over, who))).toEqual({ status: 'skipped', reason });
  });

  it('template_not_approved, no_phone, low_balance and marketing_limit', async () => {
    const notApproved = await scheduled();
    await WhatsAppTemplateModel.updateOne({ _id: templateId }, { $set: { status: 'PAUSED' } });
    expect(await send(notApproved)).toEqual({ status: 'skipped', reason: 'template_not_approved' });
    await WhatsAppTemplateModel.updateOne({ _id: templateId }, { $set: { status: 'APPROVED' } });

    const gone = await scheduled();
    const row = await PostCallMessageModel.findById(gone).lean();
    await ContactModel.updateOne({ _id: row?.contactId }, { $set: { deletedAt: new Date() } });
    expect(await send(gone)).toEqual({ status: 'skipped', reason: 'no_phone' });

    const poor = await scheduled();
    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 0 } },
    );
    expect(await send(poor)).toEqual({ status: 'skipped', reason: 'low_balance' });
    await WalletModel.updateOne(
      { accountId: state.acc.account._id },
      { $set: { balanceMicros: 1_000_000_000 } },
    );

    await WhatsAppTemplateModel.updateOne({ _id: templateId }, { $set: { category: 'MARKETING' } });
    const c = await contact();
    const twice = async () => {
      const call = await endedCall({}, c);
      const r = await PostCallMessageModel.create({
        accountId: state.acc.account._id,
        callId: call._id,
        contactId: c._id,
        source: 'flow:m',
        channelId: state.channel._id,
        templateId: new Types.ObjectId(templateId),
        templateName,
        language: 'en',
        variables: { '1': 'A', '2': 'B', '3': 'C' },
        scheduledAt: new Date(),
      });
      return send(r._id.toString());
    };
    expect(await twice()).toEqual({ status: 'sent' });
    expect(await twice()).toEqual({ status: 'skipped', reason: 'marketing_limit' });
  });

  it('an opt-out between scheduling and sending wins; nothing personal is logged', async () => {
    const lines: unknown[] = [];
    vi.spyOn(logger.getLogger(), 'info').mockImplementation((...args: unknown[]) => {
      lines.push(args);
    });
    const id = await scheduled({}, { name: 'Secret Name' });
    const row = await PostCallMessageModel.findById(id).lean();
    await ContactModel.updateOne({ _id: row?.contactId }, { $set: { optedOutAt: new Date() } });
    expect(await send(id)).toEqual({ status: 'skipped', reason: 'opted_out' });
    const text = JSON.stringify(lines);
    expect(text).toContain('post-call: message handled');
    expect(text).not.toContain('Secret Name');
    expect(text).not.toContain('+9190011');
  });
});

describe('timing', () => {
  const window = { start: '09:00', end: '19:00', days: [1, 2, 3, 4, 5, 6] };
  const tz = 'Asia/Kolkata';
  it.each([
    // Wed 10:20 IST → 11:00 IST
    ['2026-10-28T04:50:00Z', '2026-10-28T05:30:00Z'],
    // Wed 11:00 IST exactly → 11:00
    ['2026-10-28T05:30:00Z', '2026-10-28T05:30:00Z'],
    // Wed 21:10 IST → Thu 09:00 IST (across midnight)
    ['2026-10-28T15:40:00Z', '2026-10-29T03:30:00Z'],
    // Sat 19:30 IST → Mon 09:00 IST (Sunday off)
    ['2026-10-31T14:00:00Z', '2026-11-02T03:30:00Z'],
  ])('next window hour after %s is %s', (now, at) => {
    expect(nextWindowHour(new Date(now), window, tz)?.toISOString()).toBe(
      new Date(at).toISOString(),
    );
  });

  it('now / after D minutes / next window hour; an empty window falls back to now', () => {
    const now = new Date('2026-10-28T15:40:00Z');
    expect(scheduledAtFor({ mode: 'now', delayMinutes: null }, now, window, tz)).toEqual(now);
    expect(scheduledAtFor({ mode: 'after', delayMinutes: 90 }, now, window, tz).toISOString()).toBe(
      '2026-10-28T17:10:00.000Z',
    );
    expect(
      scheduledAtFor(
        { mode: 'next_window_hour', delayMinutes: null },
        now,
        { ...window, days: [] },
        tz,
      ),
    ).toEqual(now);
  });
});

describe('/outcome-rules', () => {
  const body = () => ({
    name: 'Reminder',
    when: { dispositions: ['promise_to_pay'] },
    send: { templateId, params: [{ from: 'contact', key: 'name' }] },
    timing: { mode: 'next_window_hour' },
  });

  it('CRUD for owners / admins (audited); managers and keys are refused; tenant isolated', async () => {
    const created = await request(app())
      .post('/api/v1/outcome-rules')
      .set(bearer(users.owner.token))
      .send(body());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.data).toMatchObject({
      name: 'Reminder',
      active: true,
      send: { template: { name: templateName, language: 'en' } },
      timing: { mode: 'next_window_hour' },
    });
    const id = created.body.data.id as string;
    const patched = await request(app())
      .patch(`/api/v1/outcome-rules/${id}`)
      .set(bearer(users.admin.token))
      .send({ active: false, order: 3 });
    expect(patched.body.data).toMatchObject({ active: false, order: 3 });
    expect(
      (await request(app()).get('/api/v1/outcome-rules').set(bearer(users.manager.token))).status,
    ).toBe(403);
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    expect(
      (
        await request(app())
          .patch(`/api/v1/outcome-rules/${id}`)
          .set(bearer(otherOwner.token))
          .send({ name: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (await request(app()).delete(`/api/v1/outcome-rules/${id}`).set(bearer(users.owner.token)))
        .status,
    ).toBe(204);
    const actions = (await AuditLogModel.find({ 'target.id': id }).sort({ at: 1 }).lean()).map(
      (a) => a.action,
    );
    expect(actions).toEqual([
      'outcome_rule.created',
      'outcome_rule.updated',
      'outcome_rule.deleted',
    ]);
  });

  it.each([
    ['an unknown template', { send: { templateId: new Types.ObjectId().toString(), params: [] } }],
    [
      'too many params',
      {
        send: {
          templateId,
          params: Array.from({ length: 4 }, () => ({ from: 'text', value: 'x' })),
        },
      },
    ],
    ['"after" without minutes', { timing: { mode: 'after' } }],
    ['a delay over a day', { timing: { mode: 'after', delayMinutes: 1441 } }],
    ['a text param without a value', { send: { templateId, params: [{ from: 'text' }] } }],
    [
      'an unknown number',
      { send: { templateId, channelId: new Types.ObjectId().toString(), params: [] } },
    ],
  ])('rejects %s', async (_n, over) => {
    const res = await request(app())
      .post('/api/v1/outcome-rules')
      .set(bearer(users.owner.token))
      .send({ ...body(), ...over });
    expect(res.status).toBe(422);
  });

  it('allows 20 rules per account', async () => {
    for (let i = 0; i < 20; i += 1) await rule({ name: `r${String(i)}` });
    const res = await request(app())
      .post('/api/v1/outcome-rules')
      .set(bearer(users.owner.token))
      .send(body());
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OUTCOME_RULE_LIMIT');
  });
});

describe('Send WhatsApp step warnings at publish', () => {
  const graph = (config: Record<string, unknown>) =>
    FlowGraphSchema.parse({
      schemaVersion: 1,
      nodes: [
        { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
        { id: 'wa', type: 'send_whatsapp', label: 'Reminder', position: { x: 0, y: 100 }, config },
        { id: 'bye', type: 'hangup', position: { x: 0, y: 200 }, config: {} },
      ],
      edges: [
        { id: 'e1', source: 'start', sourceHandle: 'next', target: 'wa' },
        { id: 'e2', source: 'wa', sourceHandle: 'next', target: 'bye' },
      ],
      variables: [],
    });

  it('warns (never blocks) when the template is not approved or the number is missing', async () => {
    const accountId = state.acc.account._id;
    expect(await whatsappStepIssues(accountId, graph({ templateName, language: 'en' }))).toEqual(
      [],
    );
    const [missing] = await whatsappStepIssues(
      accountId,
      graph({ templateName: 'nope', language: 'en_US' }),
    );
    expect(missing).toMatchObject({
      severity: 'warning',
      code: 'template_not_approved',
      nodeId: 'wa',
    });
    const [badNumber] = await whatsappStepIssues(
      accountId,
      graph({ templateName, language: 'en', channelId: new Types.ObjectId().toString() }),
    );
    expect(badNumber?.message).toContain('choose the WhatsApp number');
    const empty = await createTestAccount();
    const [noNumber] = await whatsappStepIssues(empty.account._id, graph({ templateName }));
    expect(noNumber?.message).toContain('connect a WhatsApp number');
  });

  it('the step accepts Meta language codes and a number', () => {
    const g = graph({ templateName, language: 'en_US', channelId: state.channel._id.toString() });
    expect(g.nodes[1]?.config).toMatchObject({
      language: 'en_US',
      channelId: state.channel._id.toString(),
    });
  });
});
