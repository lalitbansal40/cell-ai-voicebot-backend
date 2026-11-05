import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallModel } from '../../src/db/models/call.model';
import { PhoneNumberModel, defaultInbound } from '../../src/db/models/phone-number.model';
import type { CallManager } from '../../src/modules/calls/call.service';
import type { CallRegistry } from '../../src/modules/calls/registry';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { createAgentDoc } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

/** Phase 20 (P20-T6): who answers a number, its readiness, and the callback list. */

useTestDb();
let a: TestAccount;
let b: TestAccount;
let owner: TestUser;
let viewer: TestUser;
let agentUser: TestUser;
let numberId: string;
let agentId: string;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
// the calls router needs a call manager; these routes never reach it
const app = buildTestApp(
  {},
  {
    calls: {
      manager: {} as CallManager,
      registry: { liveCalls: () => Promise.resolve([]) } as unknown as CallRegistry,
      textInput: false,
      voiceProvider: 'fake' as const,
    },
  },
);

const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  route: 'ai',
  program: { kind: 'agent', id: agentId },
  greeting: '',
  ringUserIds: null,
  ringTimeoutSec: 30,
  callHours: { enabled: false, timezone: 'Asia/Kolkata', weekly: [], holidays: [] },
  afterHours: { action: 'message', message: 'Office band hai.' },
  ...over,
});

beforeAll(async () => {
  a = await createTestAccount({ name: 'Acme' });
  b = await createTestAccount({ name: 'Beta' });
  owner = await a.addUser('owner');
  viewer = await a.addUser('viewer');
  agentUser = await a.addUser('agent');
  agentId = await createAgentDoc(a.account._id, 'Front desk');
  numberId = (
    await PhoneNumberModel.create({
      number: '+911600000001',
      kind: '1600',
      accountId: a.account._id,
      purpose: 'both',
      label: 'Support',
    })
  )._id.toString();
  // an outbound-only number is not listed
  await PhoneNumberModel.create({
    number: '+911600000002',
    kind: '1600',
    accountId: a.account._id,
    purpose: 'outbound',
  });
});

const patch = (u: TestUser, body: object, id = numberId) =>
  request(app).patch(`/api/v1/phone-numbers/${id}/inbound`).set(header(u)).send(body);

describe('incoming call settings (P20-T6)', () => {
  it('lists inbound numbers with readiness; a new number is off', async () => {
    const res = await request(app).get('/api/v1/phone-numbers/inbound').set(header(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      number: '+911600000001',
      purpose: 'both',
      inbound: { enabled: false, route: 'ai', program: null },
      readiness: { line: false, server: false, program: false },
    });
    expect(res.body.data[0].readiness.problems).toContain('Incoming calls are off for this number');
  });

  it('saves who answers (owner); refuses missing / inactive programs, viewers and other accounts', async () => {
    expect((await patch(viewer, settings())).status).toBe(403);
    const missing = await patch(owner, settings({ program: null }));
    expect(missing.body.error.code).toBe('INBOUND_PROGRAM_REQUIRED');
    await AiAgentModel.updateOne({ _id: agentId }, { $set: { isActive: false } });
    expect((await patch(owner, settings())).body.error.code).toBe('INBOUND_PROGRAM_NOT_READY');
    await AiAgentModel.updateOne({ _id: agentId }, { $set: { isActive: true } });
    const bad = await patch(
      owner,
      settings({
        callHours: {
          enabled: true,
          timezone: 'Asia/Kolkata',
          weekly: [{ day: 'MONDAY', open: '1800', close: '0900' }],
          holidays: [],
        },
      }),
    );
    expect(bad.status).toBe(422);
    const ok = await patch(
      owner,
      settings({
        route: 'team_then_ai',
        ringUserIds: [agentUser.user._id.toString()],
        greeting: 'Namaste',
      }),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      inbound: {
        enabled: true,
        route: 'team_then_ai',
        greeting: 'Namaste',
        program: { kind: 'agent', id: agentId },
        ringUserIds: [agentUser.user._id.toString()],
      },
      readiness: { program: true, teamMembers: 1 },
    });
    // a team route needs no program; strangers' numbers are 404
    expect((await patch(owner, settings({ route: 'team', program: null }))).status).toBe(200);
    const other = await PhoneNumberModel.create({
      number: '+911600000009',
      kind: '1600',
      accountId: b.account._id,
      purpose: 'inbound',
      inbound: defaultInbound(),
    });
    expect((await patch(owner, settings(), other._id.toString())).status).toBe(404);
    const row = await AuditLogModel.findOne({ action: 'phone_number.inbound_updated' }).lean();
    expect(row?.meta).toMatchObject({ numberLast4: '0001', enabled: true });
  });

  it('the callback list: missed=open lists it, callback-done takes it off', async () => {
    const now = new Date();
    const missed = await CallModel.create({
      accountId: a.account._id,
      direction: 'inbound',
      provider: 'sip',
      from: '+919000000001',
      to: '+911600000001',
      source: { kind: null },
      status: 'no_answer',
      timestamps: { queuedAt: now, endedAt: now },
      inbound: {
        did: '+911600000001',
        phoneNumberId: new Types.ObjectId(numberId),
        numberLabel: 'Support',
        route: 'team',
        callerHidden: false,
      },
      missed: { reason: 'no_answer', callback: { status: 'open', doneBy: null, doneAt: null } },
    });
    const list = await request(app).get('/api/v1/calls?missed=open').set(header(owner));
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data.map((c: { id: string }) => c.id)).toEqual([missed._id.toString()]);
    expect(list.body.data[0]).toMatchObject({
      direction: 'inbound',
      inbound: { did: '+911600000001', route: 'team' },
      missed: { reason: 'no_answer', callback: { status: 'open' } },
    });
    const done = await request(app)
      .post(`/api/v1/calls/${missed._id.toString()}/callback-done`)
      .set(header(owner));
    expect(done.status).toBe(200);
    expect(done.body.data.missed.callback).toMatchObject({
      status: 'done',
      doneBy: owner.user._id.toString(),
    });
    expect(
      (await request(app).get('/api/v1/calls?missed=open').set(header(owner))).body.data,
    ).toEqual([]);
    // answering a call that is not ringing
    const answer = await request(app)
      .post(`/api/v1/calls/${missed._id.toString()}/answer`)
      .set(header(agentUser));
    expect(answer.body.error.code).toBe('CALL_NOT_RINGING');
  });
});
