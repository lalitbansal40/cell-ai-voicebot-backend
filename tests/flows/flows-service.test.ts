import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FlowGraphSchema } from '../../src/core/engine/schema';
import { FlowModel } from '../../src/db/models/flow.model';
import {
  flowInvalid,
  graphRefs,
  graphStats,
  publicGraph,
  sealGraph,
} from '../../src/modules/flows/flows.service';
import * as inUse from '../../src/modules/flows/in-use';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, newFlow } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const KEY = Buffer.alloc(32, 7);
const OID = '0123456789abcdef01234567';

let t: TestAccount;
let manager: TestUser;

beforeAll(async () => {
  t = await createTestAccount({ name: 'Service Co' });
  manager = await t.addUser('manager');
});

afterEach(() => vi.restoreAllMocks());

const graph = (nodes: object[]) =>
  FlowGraphSchema.parse({
    schemaVersion: 1,
    nodes: nodes.map((n, i) => ({ position: { x: 0, y: i }, config: {}, ...n })),
    edges: [],
  });

describe('graph helpers', () => {
  it('collects agent / audio refs incl. audio prompts; stats without a start', () => {
    const g = graph([
      {
        id: 'a',
        type: 'gather_speech',
        config: { prompt: { kind: 'audio', audioId: OID.toUpperCase() } },
      },
      { id: 'b', type: 'play_audio', config: { audioId: OID } },
      { id: 'c', type: 'ai_agent', config: { agentId: 'bad' } },
    ]);
    expect(graphRefs(g).audios.map(String)).toEqual([OID]);
    expect(graphRefs(g).agents).toEqual([]);
    expect(graphStats(g)).toMatchObject({ nodes: 3, triggers: [] });
    const bad = graph([{ id: 's', type: 'start', config: { triggers: [] } }]);
    expect(graphStats(bad).triggers).toEqual(['campaign', 'inbound', 'api', 'test']);
  });

  it('seals only secret headers; public graphs drop sealed values (hints optional)', () => {
    const g = graph([
      {
        id: 'api',
        type: 'api_request',
        config: {
          url: 'https://x',
          headers: [
            { name: 'X-Plain', value: 'v', sealed: 'forged' },
            { name: 'X-Secret', secret: true, value: 'topsecret1234' },
          ],
        },
      },
      { id: 'other', type: 'api_request', config: { url: 'https://y' } },
    ]);
    const sealed = sealGraph(g, null, KEY);
    const headers = sealed.nodes[0]!.config.headers as Record<string, unknown>[];
    expect(headers[0]).toEqual({ name: 'X-Plain', value: 'v' });
    expect(headers[1]).toMatchObject({ secret: true, value: null, valueHint: '••••1234' });
    expect(publicGraph(sealed).nodes[0]!.config.headers).toEqual([
      { name: 'X-Plain', value: 'v' },
      { name: 'X-Secret', secret: true, value: null, valueHint: '••••1234' },
    ]);
    expect(publicGraph(sealed, false).nodes[0]!.config.headers).toEqual([
      { name: 'X-Plain', value: 'v' },
      { name: 'X-Secret', secret: true, value: null },
    ]);
    const noHint = {
      ...sealed,
      nodes: [
        {
          ...sealed.nodes[0]!,
          config: { url: 'x', headers: [{ name: 'S', secret: true, value: null }] },
        },
      ],
    };
    expect(publicGraph(noHint).nodes[0]!.config.headers).toEqual([
      { name: 'S', secret: true, value: null },
    ]);
  });

  it('FLOW_INVALID message and detail paths', () => {
    const one = flowInvalid([{ severity: 'error', code: 'no_ending', message: 'm' }]);
    expect(one.message).toBe('The call flow has 1 problem to fix before publishing.');
    expect(one.details).toEqual([
      { path: 'graph', message: 'm', issue: 'no_ending', severity: 'error' },
    ]);
    const edge = flowInvalid([
      { severity: 'error', code: 'edge_invalid', message: 'e', edgeId: 'e1' },
    ]);
    expect(edge.details?.[0]).toMatchObject({ path: 'edges.e1', edgeId: 'e1' });
  });
});

describe('service edges', () => {
  it('a flow in use cannot be deleted', async () => {
    const a = await newFlow(app, manager, 'In use flow');
    vi.spyOn(inUse, 'campaignsUsingFlow').mockResolvedValue([{ id: 'c1', name: 'October run' }]);
    const res = await request(app).delete(`${FLOWS}/${a.id}`).set(auth(manager));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'RESOURCE_IN_USE',
      message: 'This flow is used by 1 campaign. Cancel or finish them first.',
      details: [{ path: 'campaigns', message: 'October run', id: 'c1' }],
    });
  });

  it('variables of a legacy draft without a variables list', async () => {
    const f = await FlowModel.create({
      accountId: t.account._id,
      name: 'Legacy',
      draft: { nodes: [] },
    });
    const res = await request(app).get(`${FLOWS}/${f._id.toString()}/variables`).set(auth(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.every((v: { source: string }) => v.source !== 'flow')).toBe(true);
  });
});
