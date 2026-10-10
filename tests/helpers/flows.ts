import type { Express } from 'express';
import type { Types } from 'mongoose';
import request from 'supertest';

import { AiAgentModel } from '../../src/db/models/ai-agent.model';

export const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
export const FLOWS = '/api/v1/flows';

type RawNode = { id: string; type: string; label?: string; config?: Record<string, unknown> };

/** A small valid graph: start → speak → menu(1 → bye, 2 → api → bye) — optionally an AI node. */
export const sampleGraph = (opts: { agentId?: string; secretHeader?: string | null } = {}) => {
  const nodes: RawNode[] = [
    { id: 'start', type: 'start' },
    { id: 'greet', type: 'speak', label: 'Greeting', config: { text: 'Namaste {{name}}' } },
    {
      id: 'menu',
      type: 'gather_dtmf',
      label: 'Menu',
      config: {
        prompt: { kind: 'speak', text: '1 ya 2 dabaiye' },
        keys: [
          { id: 'k1', key: '1', label: 'Bye' },
          { id: 'k2', key: '2', label: 'Check' },
        ],
      },
    },
    {
      id: 'api',
      type: 'api_request',
      config: {
        method: 'GET',
        url: 'https://api.example.com/status?phone={{contact.phone}}',
        headers:
          opts.secretHeader === undefined
            ? []
            : [{ name: 'X-Api-Key', secret: true, value: opts.secretHeader }],
      },
    },
    { id: 'bye', type: 'hangup', config: { text: 'Dhanyavaad.' } },
  ];
  const edges: [string, string, string][] = [
    ['start', 'next', 'greet'],
    ['greet', 'next', 'menu'],
    ['menu', 'key_k1', 'bye'],
    ['menu', 'key_k2', opts.agentId ? 'ai' : 'api'],
    ['api', 'success', 'bye'],
  ];
  if (opts.agentId) {
    nodes.push({ id: 'ai', type: 'ai_agent', config: { agentId: opts.agentId } });
    edges.push(['ai', 'resolved', 'api']);
  }
  return {
    schemaVersion: 1,
    nodes: nodes.map((n, i) => ({ position: { x: 0, y: i * 120 }, config: {}, ...n })),
    edges: edges.map(([source, sourceHandle, target]) => ({
      id: `e_${source}_${sourceHandle}`,
      source,
      sourceHandle,
      target,
    })),
    variables: [],
  };
};

export const createAgentDoc = async (accountId: Types.ObjectId, name: string, isActive = true) =>
  (
    await AiAgentModel.create({ accountId, name, isActive, model: { textModel: 'gpt-4.1-mini' } })
  )._id.toString();

/** Creates a flow through the API and returns `{ id, revision }`. */
export const newFlow = async (
  app: Express,
  u: { token: string },
  name: string,
  body: Record<string, unknown> = {},
) => {
  const res = await request(app)
    .post(FLOWS)
    .set(auth(u))
    .send({ name, ...body });
  if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; revision: number } & Record<string, unknown>;
};

export const saveGraph = (
  app: Express,
  u: { token: string },
  id: string,
  revision: number,
  graph: unknown,
) => request(app).put(`${FLOWS}/${id}/draft`).set(auth(u)).send({ revision, graph });
