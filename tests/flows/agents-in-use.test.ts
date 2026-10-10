import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { FlowNodeStatsModel } from '../../src/db/models/flow-node-stats.model';
import { FlowRunModel } from '../../src/db/models/flow-run.model';
import { FlowVersionModel } from '../../src/db/models/flow-version.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { purgeDeletedAgents } from '../../src/modules/ai-agents/maintenance';
import { flowsUsingAudio, isAudioInUse, isFlowInUse } from '../../src/modules/flows/in-use';
import { purgeDeletedFlows } from '../../src/modules/flows/maintenance';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, createAgentDoc, newFlow, sampleGraph, saveGraph } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();

let t: TestAccount;
let manager: TestUser;

beforeAll(async () => {
  t = await createTestAccount({ name: 'In Use Co' });
  manager = await t.addUser('manager');
});

const DAY = 24 * 60 * 60 * 1000;

describe('agents used by flows', () => {
  it('blocks deleting an agent used by a draft, lists the flows in usage, allows after removal', async () => {
    const agentId = await createAgentDoc(t.account._id, 'Used Agent');
    const a = await newFlow(app, manager, 'Uses agent');
    await saveGraph(app, manager, a.id, 1, sampleGraph({ agentId }));
    const usage = await request(app).get(`/api/v1/agents/${agentId}/usage`).set(auth(manager));
    expect(usage.body.data.flows).toEqual([{ id: a.id, name: 'Uses agent', status: 'draft' }]);
    const del = await request(app).delete(`/api/v1/agents/${agentId}`).set(auth(manager));
    expect(del.status).toBe(409);
    expect(del.body.error).toMatchObject({
      code: 'RESOURCE_IN_USE',
      message: 'This agent is used by 1 call flow. Remove it from them first.',
      details: [{ path: 'flows', message: 'Uses agent', id: a.id }],
    });
    await saveGraph(app, manager, a.id, 2, sampleGraph());
    expect((await request(app).delete(`/api/v1/agents/${agentId}`).set(auth(manager))).status).toBe(
      204,
    );
  });

  it('a published version keeps the agent in use until a version without it is published', async () => {
    const agentId = await createAgentDoc(t.account._id, 'Published Agent');
    const a = await newFlow(app, manager, 'Published use');
    await saveGraph(app, manager, a.id, 1, sampleGraph({ agentId }));
    await request(app).post(`${FLOWS}/${a.id}/publish`).set(auth(manager)).send({ revision: 2 });
    await saveGraph(app, manager, a.id, 2, sampleGraph());
    const stillUsed = await request(app).delete(`/api/v1/agents/${agentId}`).set(auth(manager));
    expect(stillUsed.status).toBe(409);
    await request(app).post(`${FLOWS}/${a.id}/publish`).set(auth(manager)).send({ revision: 3 });
    expect((await request(app).delete(`/api/v1/agents/${agentId}`).set(auth(manager))).status).toBe(
      204,
    );
  });

  it('the purge skips soft-deleted agents still used by a flow', async () => {
    const usedId = await createAgentDoc(t.account._id, 'Purge used');
    const freeId = await createAgentDoc(t.account._id, 'Purge free');
    await FlowModel.create({
      accountId: t.account._id,
      name: 'Holds agent',
      draft: {},
      stats: { nodes: 1, agents: [usedId], audios: [], triggers: [] },
    });
    const old = new Date(Date.now() - 40 * DAY);
    await AiAgentModel.updateMany(
      { _id: { $in: [usedId, freeId] } },
      { $set: { deletedAt: old } },
    ).setOptions({
      withDeleted: true,
    });
    await purgeDeletedAgents();
    const left = await AiAgentModel.find({ _id: { $in: [usedId, freeId] } })
      .setOptions({ withDeleted: true })
      .lean();
    expect(left.map((x) => x._id.toString())).toEqual([usedId]);
  });

  it('audio in use and flow in use helpers', async () => {
    const audioId = '0123456789abcdef01234567';
    await FlowModel.create({
      accountId: t.account._id,
      name: 'Holds audio',
      draft: {},
      stats: { nodes: 1, agents: [], audios: [audioId], triggers: [] },
    });
    expect(await isAudioInUse(audioId)).toBe(true);
    expect((await flowsUsingAudio(audioId)).map((f) => f.name)).toEqual(['Holds audio']);
    expect(await isAudioInUse('not-an-id')).toBe(false);
    expect(await isFlowInUse(audioId)).toBe(false);
  });
});

describe('flows purge', () => {
  it('hard-deletes flows deleted > 30 days ago with versions, runs and stats', async () => {
    const make = async (name: string, deletedAt: Date | null) => {
      const f = await FlowModel.create({ accountId: t.account._id, name, draft: {}, deletedAt });
      await FlowVersionModel.create({
        accountId: t.account._id,
        flowId: f._id,
        version: 1,
        graph: {},
        checksum: 'x',
        publishedAt: new Date(),
      });
      await FlowRunModel.create({
        accountId: t.account._id,
        flowId: f._id,
        mode: 'simulator',
        versionRef: 1,
        graphChecksum: 'x',
      });
      await FlowNodeStatsModel.create({
        accountId: t.account._id,
        flowId: f._id,
        version: 1,
        nodeId: 'a',
        day: '2026-10-10',
        mode: 'simulator',
      });
      return f._id;
    };
    const old = await make('Old deleted', new Date(Date.now() - 31 * DAY));
    const recent = await make('Recent deleted', new Date(Date.now() - 5 * DAY));
    const live = await make('Live', null);
    expect(await purgeDeletedFlows()).toEqual({ purged: 1 });
    expect(await FlowModel.countDocuments({ _id: old }).setOptions({ withDeleted: true })).toBe(0);
    expect(await FlowVersionModel.countDocuments({ flowId: old })).toBe(0);
    expect(await FlowRunModel.countDocuments({ flowId: old })).toBe(0);
    expect(await FlowNodeStatsModel.countDocuments({ flowId: old })).toBe(0);
    for (const id of [recent, live]) {
      expect(await FlowModel.countDocuments({ _id: id }).setOptions({ withDeleted: true })).toBe(1);
      expect(await FlowVersionModel.countDocuments({ flowId: id })).toBe(1);
    }
  });
});
