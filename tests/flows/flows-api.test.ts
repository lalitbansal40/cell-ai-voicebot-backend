import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FLOW_LIMITS } from '../../src/config/limits';
import * as notify from '../../src/core/realtime/notify';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, createAgentDoc, newFlow, sampleGraph, saveGraph } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let agentUser: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  t = await createTestAccount({ name: 'Acme Finance' });
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  agentUser = await t.addUser('agent');
  viewer = await t.addUser('viewer');
});

afterEach(() => vi.restoreAllMocks());

describe('flows CRUD', () => {
  it('creates a blank flow (start → hang up), audits and notifies', async () => {
    const spy = vi.spyOn(notify, 'notifyAccount');
    const res = await request(app)
      .post(FLOWS)
      .set(auth(manager))
      .send({ name: 'Blank flow', description: 'Testing' });
    expect(res.status).toBe(201);
    const flow = res.body.data;
    expect(flow).toMatchObject({
      name: 'Blank flow',
      description: 'Testing',
      status: 'draft',
      revision: 1,
      publishedVersion: null,
      hasUnpublishedChanges: true,
      nodesCount: 2,
      triggers: ['campaign', 'inbound', 'api', 'test'],
      agents: [],
      templateKey: null,
      updatedBy: { id: manager.user._id.toString(), name: manager.user.name },
      issues: [],
    });
    expect(flow.draft.nodes.map((n: { type: string }) => n.type)).toEqual(['start', 'hangup']);
    expect(flow.draft.settings.maxDurationSec).toBe(900);
    expect(spy).toHaveBeenCalledWith(t.account._id.toString(), 'flow.updated', {
      flowId: flow.id,
      revision: 1,
      by: manager.user._id.toString(),
    });
    const log = await AuditLogModel.findOne({
      action: 'flow.created',
      'target.id': flow.id,
    }).lean();
    expect(log?.meta).toEqual({ name: 'Blank flow', source: 'blank', templateKey: null });
  });

  it('lists with search, status filter and pagination; gets one', async () => {
    const a = await newFlow(app, manager, 'Alpha list');
    await newFlow(app, manager, 'Beta list');
    const res = await request(app).get(`${FLOWS}?q=alpha&limit=5`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data.map((f: { name: string }) => f.name)).toEqual(['Alpha list']);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 5, total: 1, totalPages: 1 });
    expect(res.body.data[0]).not.toHaveProperty('draft');
    const drafts = await request(app).get(`${FLOWS}?status=published`).set(auth(viewer));
    expect(drafts.body.data).toEqual([]);
    const one = await request(app).get(`${FLOWS}/${a.id}`).set(auth(agentUser));
    expect(one.status).toBe(200);
    expect(one.body.data.id).toBe(a.id);
    expect((await request(app).get(`${FLOWS}?status=live`).set(auth(viewer))).status).toBe(422);
  });

  it('refuses duplicate names (case-insensitive) and the 101st flow', async () => {
    await newFlow(app, manager, 'Unique name');
    const dup = await request(app).post(FLOWS).set(auth(manager)).send({ name: 'UNIQUE NAME' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT_DUPLICATE');
    const s = await createTestAccount();
    const so = await s.addUser('owner');
    await FlowModel.insertMany(
      Array.from({ length: FLOW_LIMITS.flowsPerAccount }, (_, i) => ({
        accountId: s.account._id,
        name: `f${String(i)}`,
        draft: {},
      })),
    );
    const res = await request(app).post(FLOWS).set(auth(so)).send({ name: 'One too many' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_INVALID_STATE');
  });

  it('renames (no revision bump), refuses a taken name, audits field names', async () => {
    const a = await newFlow(app, manager, 'Rename me');
    await newFlow(app, manager, 'Taken name');
    const res = await request(app)
      .patch(`${FLOWS}/${a.id}`)
      .set(auth(manager))
      .send({ name: 'Renamed', description: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', description: null, revision: 1 });
    const log = await AuditLogModel.findOne({ action: 'flow.updated', 'target.id': a.id }).lean();
    expect(log?.meta).toEqual({ fields: ['name', 'description'] });
    const taken = await request(app)
      .patch(`${FLOWS}/${a.id}`)
      .set(auth(manager))
      .send({ name: 'taken NAME' });
    expect(taken.status).toBe(409);
    expect((await request(app).patch(`${FLOWS}/${a.id}`).set(auth(manager)).send({})).status).toBe(
      422,
    );
  });

  it('duplicates the draft as "… (copy)", then "… (copy 2)"', async () => {
    const a = await newFlow(app, manager, 'Dup source');
    const first = await request(app).post(`${FLOWS}/${a.id}/duplicate`).set(auth(manager));
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      name: 'Dup source (copy)',
      revision: 1,
      status: 'draft',
    });
    const second = await request(app).post(`${FLOWS}/${a.id}/duplicate`).set(auth(manager));
    expect(second.body.data.name).toBe('Dup source (copy 2)');
    const log = await AuditLogModel.findOne({
      action: 'flow.duplicated',
      'target.id': first.body.data.id,
    }).lean();
    expect(log?.meta).toEqual({ sourceFlowId: a.id, name: 'Dup source (copy)' });
  });

  it('archives and unarchives (state rules), deletes softly and frees the name', async () => {
    const a = await newFlow(app, manager, 'Archive me');
    const arch = await request(app).post(`${FLOWS}/${a.id}/archive`).set(auth(manager));
    expect(arch.body.data.status).toBe('archived');
    expect((await request(app).post(`${FLOWS}/${a.id}/archive`).set(auth(manager))).status).toBe(
      409,
    );
    const un = await request(app).post(`${FLOWS}/${a.id}/unarchive`).set(auth(manager));
    expect(un.body.data.status).toBe('draft');
    expect((await request(app).post(`${FLOWS}/${a.id}/unarchive`).set(auth(manager))).status).toBe(
      409,
    );
    expect((await request(app).delete(`${FLOWS}/${a.id}`).set(auth(manager))).status).toBe(204);
    expect((await request(app).get(`${FLOWS}/${a.id}`).set(auth(manager))).status).toBe(404);
    await newFlow(app, manager, 'Archive me');
    const log = await AuditLogModel.findOne({ action: 'flow.deleted', 'target.id': a.id }).lean();
    expect(log?.meta).toEqual({ name: 'Archive me' });
  });
});

describe('draft saves', () => {
  it('saves with the current revision, returns issues and bumps the revision', async () => {
    const a = await newFlow(app, manager, 'Draft save');
    const res = await saveGraph(app, manager, a.id, 1, sampleGraph());
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ revision: 2, hasUnpublishedChanges: true });
    expect(res.body.data.issues.every((i: { severity: string }) => i.severity === 'warning')).toBe(
      true,
    );
    const flow = await request(app).get(`${FLOWS}/${a.id}`).set(auth(manager));
    expect(flow.body.data.nodesCount).toBe(5);
    expect(flow.body.data.revision).toBe(2);
  });

  it('a stale revision is 409 FLOW_REVISION_CONFLICT with who saved it', async () => {
    const a = await newFlow(app, manager, 'Conflict');
    expect((await saveGraph(app, owner, a.id, 1, sampleGraph())).status).toBe(200);
    const res = await saveGraph(app, manager, a.id, 1, sampleGraph());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FLOW_REVISION_CONFLICT');
    expect(res.body.error.details).toEqual([
      { path: 'revision', message: '2' },
      { path: 'updatedBy', message: owner.user.name },
      { path: 'updatedAt', message: expect.stringMatching(/^\d{4}-/) },
    ]);
  });

  it('incomplete nodes are saved and reported; structural errors are 422 at graph.<path>', async () => {
    const a = await newFlow(app, manager, 'Incomplete');
    const graph = sampleGraph();
    graph.nodes[1]!.config = { text: '' };
    const res = await saveGraph(app, manager, a.id, 1, graph);
    expect(res.status).toBe(200);
    expect(res.body.data.issues).toContainEqual(
      expect.objectContaining({ code: 'node_unconfigured', nodeId: 'greet', field: 'config.text' }),
    );
    const bad = await saveGraph(app, manager, a.id, 2, {
      ...graph,
      nodes: [{ id: 'x y', type: 'goto' }],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['graph.nodes.0.id', 'graph.nodes.0.type']),
    );
    const big = sampleGraph();
    big.nodes[1]!.config = { text: 'x'.repeat(FLOW_LIMITS.graphMaxBytes) };
    const tooBig = await saveGraph(app, manager, a.id, 2, big);
    expect(tooBig.status).toBe(413);
  });

  it('seals secret headers, never returns them, keeps them on a null value', async () => {
    const a = await newFlow(app, manager, 'Secrets');
    const secret = 'sk_live_flow_secret_9876';
    expect(
      (await saveGraph(app, manager, a.id, 1, sampleGraph({ secretHeader: secret }))).status,
    ).toBe(200);
    const stored = await FlowModel.findById(a.id).lean();
    const storedHeader = (
      stored?.draft as { nodes: { id: string; config: { headers?: Record<string, unknown>[] } }[] }
    ).nodes.find((n) => n.id === 'api')?.config.headers?.[0];
    expect(storedHeader).toMatchObject({ value: null, valueHint: '••••9876' });
    expect(String(storedHeader?.sealed)).toMatch(/^v1:/);
    const view = await request(app).get(`${FLOWS}/${a.id}`).set(auth(manager));
    expect(JSON.stringify(view.body)).not.toContain(secret);
    expect(JSON.stringify(view.body)).not.toContain(String(storedHeader?.sealed));
    const header = view.body.data.draft.nodes.find((n: { id: string }) => n.id === 'api').config
      .headers[0];
    expect(header).toEqual({ name: 'X-Api-Key', secret: true, value: null, valueHint: '••••9876' });
    // resend with value null (what the UI does) → kept
    const kept = await saveGraph(app, manager, a.id, 2, sampleGraph({ secretHeader: null }));
    expect(
      kept.body.data.issues.find(
        (i: { code: string; nodeId?: string }) => i.code === 'node_unconfigured',
      ),
    ).toBeUndefined();
    // a forged sealed value from the client is ignored
    const forged = sampleGraph({ secretHeader: null });
    (forged.nodes[3]!.config as { headers: Record<string, unknown>[] }).headers[0]!.sealed =
      'v1:forged';
    const res = await saveGraph(app, manager, a.id, 3, forged);
    expect(res.status).toBe(200);
    const after = await FlowModel.findById(a.id).lean();
    expect(JSON.stringify(after?.draft)).not.toContain('forged');
    // a new flow without a stored secret reports the missing value
    const b = await newFlow(app, manager, 'No secret');
    const missing = await saveGraph(app, manager, b.id, 1, sampleGraph({ secretHeader: null }));
    expect(missing.body.data.issues).toContainEqual(
      expect.objectContaining({ code: 'node_unconfigured', field: 'config.headers.0.value' }),
    );
    const logs = await AuditLogModel.find({ 'target.id': a.id }).lean();
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('validates the draft or a posted graph without saving (read permission)', async () => {
    const a = await newFlow(app, manager, 'Validate');
    const current = await request(app).post(`${FLOWS}/${a.id}/validate`).set(auth(viewer)).send({});
    expect(current.status).toBe(200);
    expect(current.body.data).toEqual([]);
    const graph = sampleGraph();
    graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'key_k2');
    const posted = await request(app)
      .post(`${FLOWS}/${a.id}/validate`)
      .set(auth(viewer))
      .send({ graph });
    expect(posted.body.data).toContainEqual(
      expect.objectContaining({ code: 'exit_required', nodeId: 'menu' }),
    );
    expect((await FlowModel.findById(a.id).lean())?.revision).toBe(1);
  });

  it('reports agents of other accounts as missing (never their names)', async () => {
    const other = await createTestAccount();
    const foreignAgent = await createAgentDoc(other.account._id, 'Secret Other Agent');
    const a = await newFlow(app, manager, 'Foreign agent');
    const res = await saveGraph(app, manager, a.id, 1, sampleGraph({ agentId: foreignAgent }));
    expect(res.body.data.issues).toContainEqual(
      expect.objectContaining({ code: 'agent_missing', nodeId: 'ai' }),
    );
    const view = await request(app).get(`${FLOWS}/${a.id}`).set(auth(manager));
    expect(view.body.data.agents).toEqual([]);
    expect(JSON.stringify(view.body)).not.toContain('Secret Other Agent');
  });

  it('reports audio files of other accounts as missing (never their names) and refuses to simulate', async () => {
    const other = await createTestAccount();
    const foreign = await FlowAudioModel.create({
      accountId: other.account._id,
      name: 'Secret Other Tone',
      fileKey: 'accounts/other/flow-audio/a.wav',
      format: 'wav',
      bytes: 100,
      durationMs: 1000,
      sampleRate: 8000,
      channels: 1,
    });
    const a = await newFlow(app, manager, 'Foreign audio');
    const graph = sampleGraph();
    graph.nodes = graph.nodes.map((n) =>
      n.id === 'greet'
        ? { ...n, type: 'play_audio', config: { audioId: foreign._id.toString() } }
        : n,
    );
    const res = await saveGraph(app, manager, a.id, 1, graph);
    expect(res.body.data.issues).toContainEqual(
      expect.objectContaining({ code: 'audio_missing', nodeId: 'greet' }),
    );
    const view = await request(app).get(`${FLOWS}/${a.id}`).set(auth(manager));
    expect(JSON.stringify(view.body)).not.toContain('Secret Other Tone');
    const sim = await request(app)
      .post(`${FLOWS}/${a.id}/simulations`)
      .set(auth(manager))
      .send({ version: 'draft' });
    expect(sim.status).toBe(422);
    expect(sim.body.error.code).toBe('FLOW_INVALID');
  });

  it('lists the agents a flow uses and its variables', async () => {
    const agentId = await createAgentDoc(t.account._id, 'Flow Agent One');
    const a = await newFlow(app, manager, 'With agent');
    await saveGraph(app, manager, a.id, 1, {
      ...sampleGraph({ agentId }),
      variables: [{ name: 'status', type: 'text' }],
    });
    const view = await request(app).get(`${FLOWS}/${a.id}`).set(auth(viewer));
    expect(view.body.data.agents).toEqual([{ id: agentId, name: 'Flow Agent One' }]);
    const vars = await request(app).get(`${FLOWS}/${a.id}/variables`).set(auth(viewer));
    expect(vars.status).toBe(200);
    expect(vars.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'name', source: 'contact', readOnly: true }),
        expect.objectContaining({ name: 'status', source: 'flow', readOnly: false }),
        expect.objectContaining({ name: 'promise_date', source: 'system', type: 'date' }),
      ]),
    );
  });
});

describe('catalog and templates', () => {
  it('serves the node catalogue and the template list', async () => {
    const catalog = await request(app).get(`${FLOWS}/catalog`).set(auth(viewer));
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.nodes).toHaveLength(15);
    const templates = await request(app).get(`${FLOWS}/templates`).set(auth(viewer));
    expect(templates.body.data.map((x: { key: string }) => x.key)).toEqual([
      'loan_recovery',
      'payment_reminder',
      'feedback_survey',
      'inbound_support',
    ]);
    expect(templates.body.data[0]).not.toHaveProperty('graph');
  });
});

describe('permissions and isolation', () => {
  it('viewer and agent roles read and validate only', async () => {
    const a = await newFlow(app, manager, 'Perm target');
    for (const u of [viewer, agentUser]) {
      expect((await request(app).get(`${FLOWS}/${a.id}`).set(auth(u))).status).toBe(200);
      expect((await request(app).post(FLOWS).set(auth(u)).send({ name: 'Nope' })).status).toBe(403);
      expect((await saveGraph(app, u, a.id, 1, sampleGraph())).status).toBe(403);
      expect(
        (await request(app).patch(`${FLOWS}/${a.id}`).set(auth(u)).send({ name: 'x' })).status,
      ).toBe(403);
      expect((await request(app).delete(`${FLOWS}/${a.id}`).set(auth(u))).status).toBe(403);
      expect(
        (await request(app).post(`${FLOWS}/${a.id}/publish`).set(auth(u)).send({ revision: 1 }))
          .status,
      ).toBe(403);
      expect((await request(app).post(`${FLOWS}/${a.id}/duplicate`).set(auth(u))).status).toBe(403);
      expect((await request(app).get(`${FLOWS}/${a.id}/export`).set(auth(u))).status).toBe(403);
      expect(
        (await request(app).post(`${FLOWS}/import`).set(auth(u)).send({ file: {} })).status,
      ).toBe(403);
    }
    expect((await request(app).get(FLOWS)).status).toBe(401);
  });

  it('impersonation reads but cannot write, publish or export', async () => {
    const a = await newFlow(app, manager, 'Imp target');
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    expect((await request(app).get(`${FLOWS}/${a.id}`).set(auth(imp))).status).toBe(200);
    for (const res of [
      await saveGraph(app, imp, a.id, 1, sampleGraph()),
      await request(app).post(`${FLOWS}/${a.id}/publish`).set(auth(imp)).send({ revision: 1 }),
      await request(app).get(`${FLOWS}/${a.id}/export`).set(auth(imp)),
      await request(app).post(FLOWS).set(auth(imp)).send({ name: 'Imp new' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    }
  });

  it('suspended accounts are read-only', async () => {
    const s = await createTestAccount({ status: 'suspended' });
    const so = await s.addUser('owner');
    expect((await request(app).get(FLOWS).set(auth(so))).status).toBe(200);
    expect((await request(app).post(FLOWS).set(auth(so)).send({ name: 'Blocked' })).status).toBe(
      403,
    );
  });

  it("another account's flow is 404 everywhere and never listed", async () => {
    const a = await newFlow(app, manager, 'Isolated flow');
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    const paths: [string, string, object?][] = [
      ['get', `${FLOWS}/${a.id}`],
      ['patch', `${FLOWS}/${a.id}`, { name: 'x' }],
      ['delete', `${FLOWS}/${a.id}`],
      ['put', `${FLOWS}/${a.id}/draft`, { revision: 1, graph: sampleGraph() }],
      ['post', `${FLOWS}/${a.id}/validate`, {}],
      ['post', `${FLOWS}/${a.id}/publish`, { revision: 1 }],
      ['get', `${FLOWS}/${a.id}/versions`],
      ['get', `${FLOWS}/${a.id}/versions/1`],
      ['post', `${FLOWS}/${a.id}/versions/1/restore`, { revision: 1 }],
      ['post', `${FLOWS}/${a.id}/duplicate`],
      ['post', `${FLOWS}/${a.id}/archive`],
      ['post', `${FLOWS}/${a.id}/unarchive`],
      ['get', `${FLOWS}/${a.id}/export`],
      ['get', `${FLOWS}/${a.id}/variables`],
    ];
    for (const [method, url, body] of paths) {
      const req = (request(app) as unknown as Record<string, (u: string) => request.Test>)[method]!(
        url,
      ).set(auth(o));
      const res = body ? await req.send(body) : await req;
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    expect((await request(app).get(FLOWS).set(auth(o))).body.data).toHaveLength(0);
    expect((await request(app).get(`${FLOWS}/not-an-id`).set(auth(o))).status).toBe(422);
  });
});
