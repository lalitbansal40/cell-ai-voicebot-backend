import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { FLOW_LIMITS } from '../../src/config/limits';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { FlowAudioModel } from '../../src/db/models/flow-audio.model';
import { hasForbiddenKeys } from '../../src/modules/flows/import-export';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, createAgentDoc, newFlow, sampleGraph, saveGraph } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();

let t: TestAccount;
let manager: TestUser;
let agentId: string;
let audioId: string;
const SECRET = 'sk_export_secret_5555';

const withAudio = (id: string, graph: ReturnType<typeof sampleGraph>) => ({
  ...graph,
  nodes: [
    ...graph.nodes,
    { id: 'tone', type: 'play_audio', position: { x: 300, y: 0 }, config: { audioId: id } },
  ],
});

beforeAll(async () => {
  t = await createTestAccount({ name: 'Export Co' });
  manager = await t.addUser('manager');
  agentId = await createAgentDoc(t.account._id, 'Export Agent');
  audioId = (
    await FlowAudioModel.create({
      accountId: t.account._id,
      name: 'Welcome tone',
      fileKey: 'accounts/x/flow-audio/a.wav',
      format: 'wav',
      bytes: 100,
      durationMs: 1000,
      sampleRate: 8000,
      channels: 1,
    })
  )._id.toString();
});

const exportOf = async (id: string, query = '') => {
  const res = await request(app).get(`${FLOWS}/${id}/export${query}`).set(auth(manager));
  return res;
};

describe('export', () => {
  it('downloads the draft without secrets, with agent / audio references', async () => {
    const a = await newFlow(app, manager, 'Export Me!');
    await saveGraph(
      app,
      manager,
      a.id,
      1,
      withAudio(audioId, sampleGraph({ agentId, secretHeader: SECRET })),
    );
    const res = await exportOf(a.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="flow-export-me-draft.json"',
    );
    expect(res.body).toMatchObject({
      format: 'cell-ai-flow',
      schemaVersion: 1,
      name: 'Export Me!',
      refs: {
        agents: [{ id: agentId, name: 'Export Agent' }],
        audios: [{ id: audioId, name: 'Welcome tone' }],
      },
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('sealed');
    expect(text).not.toContain('••••');
    const log = await AuditLogModel.findOne({ action: 'flow.exported', 'target.id': a.id }).lean();
    expect(log?.meta).toEqual({ version: 'draft' });
  });

  it('downloads a published version; unknown version is 404', async () => {
    const a = await newFlow(app, manager, 'Export version');
    await saveGraph(app, manager, a.id, 1, sampleGraph());
    await request(app).post(`${FLOWS}/${a.id}/publish`).set(auth(manager)).send({ revision: 2 });
    const res = await exportOf(a.id, '?version=1');
    expect(res.headers['content-disposition']).toContain('flow-export-version-v1.json');
    expect(res.body.graph.nodes).toHaveLength(5);
    expect((await exportOf(a.id, '?version=4')).status).toBe(404);
    expect((await exportOf(a.id, '?version=abc')).status).toBe(422);
  });
});

describe('import', () => {
  it('round trip in the same account keeps ids; always a new flow with a free name', async () => {
    const a = await newFlow(app, manager, 'Round trip');
    await saveGraph(
      app,
      manager,
      a.id,
      1,
      withAudio(audioId, sampleGraph({ agentId, secretHeader: SECRET })),
    );
    const file = (await exportOf(a.id)).body;
    const res = await request(app).post(`${FLOWS}/import`).set(auth(manager)).send({ file });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.flow).toMatchObject({
      name: 'Round trip (2)',
      status: 'draft',
      revision: 1,
    });
    expect(res.body.data.warnings).toEqual(['secret_removed:api.X-Api-Key']);
    const nodes = res.body.data.flow.draft.nodes;
    expect(nodes.find((n: { id: string }) => n.id === 'ai').config.agentId).toBe(agentId);
    expect(nodes.find((n: { id: string }) => n.id === 'tone').config.audioId).toBe(audioId);
    expect(res.body.data.flow.issues).toContainEqual(
      expect.objectContaining({ code: 'node_unconfigured', field: 'config.headers.0.value' }),
    );
    const named = await request(app)
      .post(`${FLOWS}/import`)
      .set(auth(manager))
      .send({ file, name: 'Custom name' });
    expect(named.body.data.flow.name).toBe('Custom name');
    const logs = await AuditLogModel.find({
      action: { $in: ['flow.imported', 'flow.created'] },
      'target.id': res.body.data.flow.id,
    }).lean();
    expect(logs.map((l) => [l.action, l.meta])).toEqual(
      expect.arrayContaining([
        ['flow.created', { name: 'Round trip (2)', source: 'import' }],
        ['flow.imported', { name: 'Round trip (2)', warnings: 1 }],
      ]),
    );
  });

  it('maps agents / audio by name in another account, else clears them with warnings', async () => {
    const a = await newFlow(app, manager, 'Cross account');
    await saveGraph(app, manager, a.id, 1, withAudio(audioId, sampleGraph({ agentId })));
    const file = (await exportOf(a.id)).body;
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    const sameName = await createAgentDoc(other.account._id, 'EXPORT AGENT');
    const res = await request(app).post(`${FLOWS}/import`).set(auth(o)).send({ file });
    expect(res.status).toBe(201);
    const nodes = res.body.data.flow.draft.nodes;
    expect(nodes.find((n: { id: string }) => n.id === 'ai').config.agentId).toBe(sameName);
    expect(nodes.find((n: { id: string }) => n.id === 'tone').config.audioId).toBe('');
    expect(res.body.data.warnings).toEqual(['audio_unmapped:tone']);
    const third = await createTestAccount();
    const t3 = await third.addUser('owner');
    const none = await request(app).post(`${FLOWS}/import`).set(auth(t3)).send({ file });
    expect(none.body.data.warnings).toEqual(['agent_unmapped:ai', 'audio_unmapped:tone']);
  });

  it('refuses hostile or wrong files', async () => {
    const good = { format: 'cell-ai-flow', schemaVersion: 1, name: 'X', graph: sampleGraph() };
    const post = (file: unknown) =>
      request(app).post(`${FLOWS}/import`).set(auth(manager)).send({ file });
    const proto = await request(app)
      .post(`${FLOWS}/import`)
      .set(auth(manager))
      .set('Content-Type', 'application/json')
      .send(
        '{"file":{"format":"cell-ai-flow","schemaVersion":1,"name":"P","graph":{"__proto__":{"admin":true}}}}',
      );
    expect(proto.status).toBe(422);
    expect(proto.body.error.details[0]).toEqual({
      path: 'file',
      message: 'The file contains forbidden keys',
    });
    expect((await post({ ...good, format: 'other' })).status).toBe(422);
    expect((await post({ ...good, schemaVersion: 2 })).status).toBe(422);
    const unknownType = await post({
      ...good,
      graph: { ...sampleGraph(), nodes: [{ id: 'a', type: 'goto', position: { x: 0, y: 0 } }] },
    });
    expect(unknownType.status).toBe(422);
    expect(unknownType.body.error.details[0].path).toBe('file.graph.nodes.0.type');
    const huge = await post({
      ...good,
      description: null,
      graph: { ...sampleGraph(), pad: 'x'.repeat(FLOW_LIMITS.importMaxBytes) },
    });
    expect(huge.status).toBe(413);
    expect((await post(null)).status).toBe(422);
  });

  it('detects forbidden keys deeply', () => {
    expect(hasForbiddenKeys({ a: [{ b: { constructor: 1 } }] })).toBe(true);
    expect(hasForbiddenKeys({ a: [{ prototype: 1 }] })).toBe(true);
    expect(hasForbiddenKeys({ a: [1, 'x', null, { ok: true }] })).toBe(false);
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 50; i += 1) {
      deep.n = {};
      deep = deep.n as Record<string, unknown>;
    }
    expect(hasForbiddenKeys(root)).toBe(true);
  });
});
