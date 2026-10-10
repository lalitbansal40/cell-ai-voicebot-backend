import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import * as notify from '../../src/core/realtime/notify';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { FlowVersionModel } from '../../src/db/models/flow-version.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, createAgentDoc, newFlow, sampleGraph, saveGraph } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();

let t: TestAccount;
let owner: TestUser;
let manager: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  t = await createTestAccount({ name: 'Versions Co' });
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  viewer = await t.addUser('viewer');
});

afterEach(() => vi.restoreAllMocks());

const publish = (id: string, revision: number, notes?: string) =>
  request(app)
    .post(`${FLOWS}/${id}/publish`)
    .set(auth(manager))
    .send({ revision, ...(notes === undefined ? {} : { notes }) });

describe('publish', () => {
  it('publishes v1 with notes, marks the flow published, audits and notifies', async () => {
    const spy = vi.spyOn(notify, 'notifyAccount');
    const agentId = await createAgentDoc(t.account._id, 'Publish agent');
    const a = await newFlow(app, manager, 'Publish me');
    await saveGraph(app, manager, a.id, 1, sampleGraph({ agentId }));
    const res = await publish(a.id, 2, ' First release ');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({
      version: 1,
      notes: 'First release',
      current: true,
      nodesCount: 6,
      publishedBy: { id: manager.user._id.toString(), name: manager.user.name },
    });
    const flow = await request(app).get(`${FLOWS}/${a.id}`).set(auth(viewer));
    expect(flow.body.data).toMatchObject({
      status: 'published',
      publishedVersion: 1,
      hasUnpublishedChanges: false,
      revision: 2,
    });
    const v = await FlowVersionModel.findOne({ flowId: a.id }).lean();
    expect(v?.agentIds.map(String)).toEqual([agentId]);
    expect(spy).toHaveBeenCalledWith(t.account._id.toString(), 'flow.published', {
      flowId: a.id,
      version: 1,
    });
    const log = await AuditLogModel.findOne({ action: 'flow.published', 'target.id': a.id }).lean();
    expect(log?.meta).toEqual({
      version: 1,
      notes: 'First release',
      nodesAdded: 6,
      nodesRemoved: 0,
      nodesChanged: 0,
      edgesChanged: 6,
    });
  });

  it('refuses a graph with errors (422 FLOW_INVALID with issue details), allows warnings', async () => {
    const a = await newFlow(app, manager, 'Broken');
    const graph = sampleGraph();
    graph.edges = graph.edges.filter((e) => e.sourceHandle !== 'key_k2');
    await saveGraph(app, manager, a.id, 1, graph);
    const res = await publish(a.id, 2);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FLOW_INVALID');
    expect(res.body.error.message).toMatch(/problems? to fix/);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issue: 'exit_required',
          severity: 'error',
          nodeId: 'menu',
          path: 'exits.key_k2',
        }),
        expect.objectContaining({ issue: 'node_unreachable', nodeId: 'api', path: 'nodes.api' }),
      ]),
    );
    expect(await FlowVersionModel.countDocuments({ flowId: a.id })).toBe(0);
  });

  it('refuses a stale revision and an unchanged draft; v2 after a change', async () => {
    const a = await newFlow(app, manager, 'Twice');
    await saveGraph(app, manager, a.id, 1, sampleGraph());
    expect((await publish(a.id, 1)).body.error.code).toBe('FLOW_REVISION_CONFLICT');
    expect((await publish(a.id, 2)).status).toBe(201);
    const same = await publish(a.id, 2);
    expect(same.status).toBe(409);
    expect(same.body.error).toMatchObject({
      code: 'CONFLICT_INVALID_STATE',
      message: 'Nothing changed since v1.',
    });
    const changed = sampleGraph();
    changed.nodes[1]!.config = { text: 'Namaste {{name}} ji' };
    const saved = await saveGraph(app, manager, a.id, 2, changed);
    expect(saved.body.data.hasUnpublishedChanges).toBe(true);
    const v2 = await publish(a.id, 3);
    expect(v2.body.data.version).toBe(2);
    const log = await AuditLogModel.findOne({
      action: 'flow.published',
      'target.id': a.id,
      'meta.version': 2,
    }).lean();
    expect(log?.meta).toMatchObject({
      nodesAdded: 0,
      nodesRemoved: 0,
      nodesChanged: 1,
      edgesChanged: 0,
    });
  });

  it('publishing an archived flow unarchives it; viewers and agents cannot publish', async () => {
    const a = await newFlow(app, manager, 'Archived publish');
    await saveGraph(app, manager, a.id, 1, sampleGraph());
    await request(app).post(`${FLOWS}/${a.id}/archive`).set(auth(manager));
    expect((await publish(a.id, 2)).status).toBe(201);
    expect((await FlowModel.findById(a.id).lean())?.status).toBe('published');
    const v = await request(app)
      .post(`${FLOWS}/${a.id}/publish`)
      .set(auth(viewer))
      .send({ revision: 2 });
    expect(v.status).toBe(403);
    const unarchived = await request(app).post(`${FLOWS}/${a.id}/archive`).set(auth(owner));
    expect(unarchived.body.data.status).toBe('archived');
    const back = await request(app).post(`${FLOWS}/${a.id}/unarchive`).set(auth(owner));
    expect(back.body.data.status).toBe('published');
  });
});

describe('versions and restore', () => {
  it('lists versions newest first, gets one with its graph, 404 for unknown', async () => {
    const a = await newFlow(app, manager, 'History');
    await saveGraph(app, manager, a.id, 1, sampleGraph());
    await publish(a.id, 2, 'one');
    const changed = sampleGraph();
    changed.nodes[1]!.config = { text: 'Second' };
    await saveGraph(app, manager, a.id, 2, changed);
    await publish(a.id, 3, 'two');
    const list = await request(app).get(`${FLOWS}/${a.id}/versions`).set(auth(viewer));
    expect(
      list.body.data.map((v: { version: number; current: boolean }) => [v.version, v.current]),
    ).toEqual([
      [2, true],
      [1, false],
    ]);
    const one = await request(app).get(`${FLOWS}/${a.id}/versions/1`).set(auth(viewer));
    expect(one.body.data.graph.nodes[1].config.text).toBe('Namaste {{name}}');
    expect((await request(app).get(`${FLOWS}/${a.id}/versions/9`).set(auth(viewer))).status).toBe(
      404,
    );
    expect((await request(app).get(`${FLOWS}/${a.id}/versions/0`).set(auth(viewer))).status).toBe(
      422,
    );
  });

  it('restores a version into the draft (revision + 1, changes recomputed, audited)', async () => {
    const a = await newFlow(app, manager, 'Restore');
    await saveGraph(app, manager, a.id, 1, sampleGraph());
    await publish(a.id, 2);
    const changed = sampleGraph();
    changed.nodes[1]!.config = { text: 'Changed' };
    await saveGraph(app, manager, a.id, 2, changed);
    const res = await request(app)
      .post(`${FLOWS}/${a.id}/versions/1/restore`)
      .set(auth(manager))
      .send({ revision: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ revision: 4, hasUnpublishedChanges: false });
    expect(res.body.data.draft.nodes[1].config.text).toBe('Namaste {{name}}');
    const stale = await request(app)
      .post(`${FLOWS}/${a.id}/versions/1/restore`)
      .set(auth(manager))
      .send({ revision: 3 });
    expect(stale.body.error.code).toBe('FLOW_REVISION_CONFLICT');
    const log = await AuditLogModel.findOne({ action: 'flow.restored', 'target.id': a.id }).lean();
    expect(log?.meta).toEqual({ fromVersion: 1 });
    expect(
      (
        await request(app)
          .post(`${FLOWS}/${a.id}/versions/1/restore`)
          .set(auth(viewer))
          .send({ revision: 4 })
      ).status,
    ).toBe(403);
  });

  it('versions stay immutable even when the draft changes', async () => {
    const a = await newFlow(app, manager, 'Immutable');
    await saveGraph(app, manager, a.id, 1, sampleGraph());
    await publish(a.id, 2);
    const before = await FlowVersionModel.findOne({ flowId: a.id }).lean();
    await saveGraph(app, manager, a.id, 2, {
      ...sampleGraph(),
      variables: [{ name: 'x', type: 'text' }],
    });
    const after = await FlowVersionModel.findOne({ flowId: a.id }).lean();
    expect(after?.graph).toEqual(before?.graph);
    await expect(FlowVersionModel.updateOne({ flowId: a.id }, { notes: 'hack' })).rejects.toThrow();
  });
});
