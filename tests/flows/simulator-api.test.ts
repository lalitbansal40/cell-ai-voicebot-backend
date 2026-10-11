import { randomUUID } from 'node:crypto';

import { MemoryStore } from 'express-rate-limit';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../src/app';
import { FLOW_LIMITS } from '../../src/config/limits';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowRunModel } from '../../src/db/models/flow-run.model';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, newFlow, saveGraph } from '../helpers/flows';
import { buildTestApp, testEnv } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();

let t: TestAccount;
let manager: TestUser;
let owner: TestUser;
let viewer: TestUser;

/** start → speak (name, flow var) → wait 3 s → menu (1 → bye) */
const graph = (text = 'Hi {{name}} {{plan}}') => ({
  schemaVersion: 1,
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
    { id: 'hi', type: 'speak', position: { x: 0, y: 1 }, config: { text } },
    { id: 'w', type: 'wait', position: { x: 0, y: 2 }, config: { seconds: 3 } },
    {
      id: 'menu',
      type: 'gather_dtmf',
      position: { x: 0, y: 3 },
      config: { prompt: { kind: 'speak', text: 'Press 1' }, keys: [{ id: 'k1', key: '1' }] },
    },
    { id: 'bye', type: 'hangup', position: { x: 0, y: 4 }, config: { text: 'Bye {{last_dtmf}}' } },
  ],
  edges: [
    { id: 'e1', source: 'start', sourceHandle: 'next', target: 'hi' },
    { id: 'e2', source: 'hi', sourceHandle: 'next', target: 'w' },
    { id: 'e3', source: 'w', sourceHandle: 'next', target: 'menu' },
    { id: 'e4', source: 'menu', sourceHandle: 'key_k1', target: 'bye' },
  ],
  variables: [{ name: 'plan', type: 'text' }],
});

const sims = (id: string) => `${FLOWS}/${id}/simulations`;
const start = (id: string, body: object = {}, u: { token: string } = manager) =>
  request(app).post(sims(id)).set(auth(u)).send(body);
const input = (id: string, runId: string, body: object, u: { token: string } = manager) =>
  request(app)
    .post(`${sims(id)}/${runId}/inputs`)
    .set(auth(u))
    .send({ clientInputId: randomUUID(), ...body });

let flowId: string;

beforeAll(async () => {
  t = await createTestAccount({ name: 'Sim Co' });
  manager = await t.addUser('manager');
  owner = await t.addUser('owner');
  viewer = await t.addUser('viewer');
  const f = await newFlow(app, manager, 'Sim flow');
  flowId = f.id;
  expect((await saveGraph(app, manager, flowId, 1, graph())).status).toBe(200);
});

describe('simulator start', () => {
  it('draft run with manual values: speaks, skips the wait, waits on the menu', async () => {
    const res = await start(flowId, { variables: { name: 'Asha', plan: 'Gold' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { run, added, replay } = res.body.data;
    expect(replay).toBe(false);
    expect(added.map((e: { kind: string; text: string }) => [e.kind, e.text])).toEqual([
      ['say', 'Hi Asha Gold'],
      ['note', 'Waited 3 s (skipped in the simulator)'],
      ['say', 'Press 1'],
    ]);
    expect(run).toMatchObject({
      versionRef: 'draft',
      status: 'waiting',
      waiting: { kind: 'dtmf', nodeId: 'menu' },
      currentNodeId: 'menu',
      contactName: 'Asha',
      costMicros: 0,
      createdBy: { id: manager.user._id.toString() },
    });
    expect(run.variables).toMatchObject({ name: 'Asha', plan: 'Gold', company: 'Sim Co' });
    expect(run).not.toHaveProperty('transcript');
  });

  it('from a contact: its fields; refuses foreign contacts and mixing contact + manual', async () => {
    const contact = await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919000500011',
      name: 'Ravi',
      source: { type: 'manual' },
    });
    const res = await start(flowId, { contactId: contact._id.toString() });
    expect(res.body.data.run.variables).toMatchObject({ name: 'Ravi', phone_last4: '0011' });
    const other = await createTestAccount();
    const foreign = await ContactModel.create({
      accountId: other.account._id,
      phoneE164: '+919000500012',
      name: 'X',
      source: { type: 'manual' },
    });
    expect((await start(flowId, { contactId: foreign._id.toString() })).status).toBe(404);
    expect(
      (await start(flowId, { contactId: contact._id.toString(), testPhone: '+919000000001' }))
        .status,
    ).toBe(422);
  });

  it('manual values: unknown / read-only / badly typed names are 422; test phone never returned', async () => {
    const bad = await start(flowId, { variables: { ghost: 'x', today: 'x' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details).toEqual([
      { path: 'variables.ghost', message: 'Not a contact field or flow variable' },
      { path: 'variables.today', message: 'Set by the flow — read-only' },
    ]);
    const f = await newFlow(app, manager, 'Typed flow');
    const g = graph('{{n}}');
    g.variables = [{ name: 'n', type: 'number' }] as never;
    await saveGraph(app, manager, f.id, 1, g);
    expect((await start(f.id, { variables: { n: 'abc' } })).body.error.details[0].path).toBe(
      'variables.n',
    );
    const phone = await start(flowId, { testPhone: '+919876500001' });
    expect(phone.body.data.run.variables.phone_last4).toBe('0001');
    expect(JSON.stringify(phone.body)).not.toContain('9876500001');
    const stored = await FlowRunModel.findById(phone.body.data.run.id).select('+testPhone').lean();
    expect(stored?.testPhone).toBe('+919876500001');
  });

  it('a draft with errors is 422; published needs a version; versions by number', async () => {
    const f = await newFlow(app, manager, 'Broken sim');
    const broken = graph();
    broken.edges = broken.edges.slice(0, 2);
    await saveGraph(app, manager, f.id, 1, broken);
    const res = await start(f.id);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FLOW_INVALID');
    expect((await start(flowId, { version: 'published' })).status).toBe(409);
    expect((await start(flowId, { version: 3 })).status).toBe(404);
    const pub = await request(app)
      .post(`${FLOWS}/${flowId}/publish`)
      .set(auth(manager))
      .send({ revision: 2 });
    expect(pub.status).toBe(201);
    expect((await start(flowId, { version: 'published' })).body.data.run.versionRef).toBe(1);
    expect((await start(flowId, { version: 1 })).body.data.run.versionRef).toBe(1);
  });
});

describe('simulator inputs', () => {
  it('a key press ends the run; replaying the same input returns the same step', async () => {
    const s = (await start(flowId)).body.data.run;
    const id = randomUUID();
    const first = await input(flowId, s.id, { clientInputId: id, kind: 'dtmf', value: '1' });
    expect(first.status).toBe(200);
    expect(first.body.data.added.map((e: { text: string }) => e.text)).toEqual([
      'Pressed 1',
      'Bye 1',
      'Call ended',
    ]);
    expect(first.body.data.run).toMatchObject({
      status: 'ended',
      endReason: 'hangup_node',
      waiting: null,
    });
    const again = await input(flowId, s.id, { clientInputId: id, kind: 'dtmf', value: '1' });
    expect(again.body.data).toMatchObject({ replay: true, added: first.body.data.added });
    const ended = await input(flowId, s.id, { kind: 'dtmf', value: '1' });
    expect(ended.status).toBe(409);
  });

  it('kind mismatch and bad values are 422; silence and hangup work', async () => {
    const s = (await start(flowId)).body.data.run;
    const mismatch = await input(flowId, s.id, { kind: 'speech', value: 'hello' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.details).toEqual([{ path: 'kind', message: 'Waiting for dtmf' }]);
    for (const body of [
      { kind: 'dtmf', value: 'abc' },
      { kind: 'speech', value: '  ' },
      { kind: 'transfer_result', value: 'maybe' },
      { kind: 'timer' },
      { kind: 'dtmf', value: '1', clientInputId: 'not-a-uuid' },
    ]) {
      expect((await input(flowId, s.id, body)).status).toBe(422);
    }
    const silent = await input(flowId, s.id, { kind: 'no_input' });
    expect(silent.body.data.added[0]).toMatchObject({ kind: 'note', text: '(silence)' });
    const hang = await input(flowId, s.id, { kind: 'hangup' });
    expect(hang.body.data.run).toMatchObject({ status: 'ended', endReason: 'customer_hangup' });
  });

  it('a running draft simulation is not changed by later draft edits', async () => {
    const f = await newFlow(app, manager, 'Snapshot');
    await saveGraph(app, manager, f.id, 1, graph('Old text'));
    const s = (await start(f.id)).body.data.run;
    await saveGraph(app, manager, f.id, 2, {
      ...graph('New text'),
      nodes: graph('New text').nodes.map((n) =>
        n.id === 'bye' ? { ...n, config: { text: 'New bye' } } : n,
      ),
    });
    const r = await input(f.id, s.id, { kind: 'dtmf', value: '1' });
    expect(r.body.data.added.map((e: { text: string }) => e.text)).toContain('Bye 1');
  });
});

describe('simulator reads, permissions, isolation, limits', () => {
  it('lists newest first (mine filter) and gets one with transcript + trace', async () => {
    await start(flowId, {}, owner);
    const all = await request(app).get(sims(flowId)).set(auth(viewer));
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThan(1);
    expect(all.body.data.length).toBeLessThanOrEqual(FLOW_LIMITS.simulationsListed);
    const mine = await request(app)
      .get(`${sims(flowId)}?mine=true`)
      .set(auth(owner));
    expect(
      mine.body.data.every(
        (r: { createdBy: { id: string } }) => r.createdBy.id === owner.user._id.toString(),
      ),
    ).toBe(true);
    const one = await request(app)
      .get(`${sims(flowId)}/${all.body.data[0].id as string}`)
      .set(auth(viewer));
    expect(one.body.data.transcript.length).toBeGreaterThan(0);
    expect(one.body.data.trace.length).toBeGreaterThan(0);
    expect(
      (
        await request(app)
          .get(`${sims(flowId)}/${'a'.repeat(24)}`)
          .set(auth(viewer))
      ).status,
    ).toBe(404);
  });

  it('viewers cannot start or send; impersonation and suspended accounts are blocked', async () => {
    expect((await start(flowId, {}, viewer)).status).toBe(403);
    const run = (await start(flowId)).body.data.run;
    expect((await input(flowId, run.id, { kind: 'no_input' }, viewer)).status).toBe(403);
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    expect((await start(flowId, {}, imp)).body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    const s = await createTestAccount({ status: 'suspended' });
    const so = await s.addUser('owner');
    expect((await request(app).post(sims(flowId)).set(auth(so)).send({})).status).toBe(403);
  });

  it("another account's runs are 404 and never listed", async () => {
    const run = (await start(flowId)).body.data.run;
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    expect(
      (
        await request(app)
          .get(`${sims(flowId)}/${run.id as string}`)
          .set(auth(o))
      ).status,
    ).toBe(404);
    expect((await input(flowId, run.id, { kind: 'no_input' }, o)).status).toBe(404);
    const theirs = await newFlow(app, o, 'Theirs');
    expect(
      (
        await request(app)
          .get(`${sims(theirs.id)}/${run.id as string}`)
          .set(auth(o))
      ).status,
    ).toBe(404);
  });

  it('61st simulator request in a minute is 429', async () => {
    const limited = buildTestApp({}, { flowRateLimitStores: { simulator: new MemoryStore() } });
    let last = 0;
    for (let i = 0; i <= FLOW_LIMITS.simulatorInputsPerMinute; i += 1) {
      last = (await request(limited).post(sims(flowId)).set(auth(manager)).send({ version: 99 }))
        .status;
    }
    expect(last).toBe(429);
  });

  it('stats: default range, version filter, validation', async () => {
    const res = await request(app).get(`${FLOWS}/${flowId}/stats`).set(auth(viewer));
    expect(res.status).toBe(200);
    const menu = res.body.data.find((s: { nodeId: string }) => s.nodeId === 'menu');
    expect(menu.entered).toBeGreaterThan(0);
    expect(menu).toHaveProperty('avgMs');
    expect(
      (
        await request(app)
          .get(`${FLOWS}/${flowId}/stats?from=2026-10-12&to=2026-10-01`)
          .set(auth(viewer))
      ).status,
    ).toBe(422);
    expect(
      (
        await request(app)
          .get(`${FLOWS}/${flowId}/stats?from=2026-01-01&to=2026-10-01`)
          .set(auth(viewer))
      ).status,
    ).toBe(422);
    expect(
      (await request(app).get(`${FLOWS}/${flowId}/stats?version=1&mode=call`).set(auth(viewer)))
        .body.data,
    ).toEqual([]);
  });
});

describe('simulator safety', () => {
  it('a save that lost the race on the run state is 409', async () => {
    const run = (await start(flowId)).body.data.run;
    const spy = vi
      .spyOn(FlowRunModel, 'findOneAndUpdate')
      .mockReturnValueOnce({ lean: () => Promise.resolve(null) } as never);
    const res = await input(flowId, run.id, { kind: 'no_input' });
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.error.message).toBe('Another input was just handled — reload the simulation.');
  });

  it('request logs carry no spoken text, customer words or phones', async () => {
    const lines: string[] = [];
    const env = testEnv({ LOG_LEVEL: 'debug' });
    const logged = createApp({
      env,
      logger: createLogger(env, { write: (s: string) => lines.push(s) }),
    });
    const run = await request(logged)
      .post(sims(flowId))
      .set(auth(manager))
      .send({ variables: { name: 'Zubeida Secretname' }, testPhone: '+919811122233' });
    await request(logged)
      .post(`${sims(flowId)}/${run.body.data.run.id as string}/inputs`)
      .set(auth(manager))
      .send({ clientInputId: randomUUID(), kind: 'dtmf', value: '1' });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of ['Zubeida', 'Secretname', '9811122233', 'Press 1', 'Bye 1'])
      expect(text).not.toContain(secret);
  });
});
