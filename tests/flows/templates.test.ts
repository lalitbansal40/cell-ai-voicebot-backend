import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { FlowGraphSchema } from '../../src/core/engine/schema';
import { validateFlow } from '../../src/core/engine/validate';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { FLOW_TEMPLATES, LOAN_TEXTS, findFlowTemplate } from '../../src/modules/flows/templates';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, createAgentDoc } from '../helpers/flows';
import { buildTestApp, testEnv } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();

let t: TestAccount;
let manager: TestUser;
let agentId: string;

beforeAll(async () => {
  t = await createTestAccount({ name: 'Template Co' });
  manager = await t.addUser('manager');
  agentId = await createAgentDoc(t.account._id, 'Recovery Bot');
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'due_date',
    label: 'Due date',
    type: 'date',
  });
});

const env = testEnv();
const BASE_CONTACT = [
  { name: 'name', label: 'Name', type: 'built_in' as const },
  { name: 'phone_last4', label: 'Last 4', type: 'built_in' as const },
];

describe('flow templates', () => {
  it.each(FLOW_TEMPLATES.map((tpl) => [tpl.key, tpl] as const))(
    '%s passes the validator once its AI nodes have an agent',
    (_key, template) => {
      const raw = template.graph(env) as {
        nodes: { id: string; config: Record<string, unknown> }[];
        variables: object[];
      };
      raw.nodes = raw.nodes.map((n) =>
        template.aiNodes.some((a) => a.nodeId === n.id)
          ? { ...n, config: { ...n.config, agentId } }
          : n,
      );
      raw.variables = [...template.optionalFields, ...raw.variables];
      const graph = FlowGraphSchema.parse(raw);
      const issues = validateFlow(graph, {
        contactVars: BASE_CONTACT,
        agents: new Map([[agentId, { active: true }]]),
        audios: new Set(),
        urlPolicy: { httpsOnly: false, allowPrivate: true, extraPorts: [5100] },
      });
      expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(
        issues.filter((i) => i.code !== 'error_exit_unconnected' && i.code !== 'sms_long'),
      ).toEqual([]);
    },
  );

  it('uses the mock API when enabled, a placeholder otherwise', () => {
    const loan = findFlowTemplate('loan_recovery');
    const url = (e: typeof env) =>
      (loan?.graph(e) as { nodes: { id: string; config: { url?: string } }[] }).nodes.find(
        (n) => n.id === 'check',
      )?.config.url;
    expect(url(env)).toBe(`${env.APP_URL}/api/v1/mock/payment-status?phone={{contact.phone}}`);
    expect(url({ ...env, MOCK_APIS_ENABLED: false })).toBe(
      'https://example.com/payment-status?phone={{contact.phone}}',
    );
    expect(findFlowTemplate('nope')).toBeUndefined();
  });

  it('creates Loan recovery with the agent picked and missing fields as flow variables', async () => {
    const res = await request(app)
      .post(FLOWS)
      .set(auth(manager))
      .send({ name: 'Loan recovery', templateKey: 'loan_recovery', agentIds: { ai: agentId } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const flow = res.body.data;
    expect(flow.templateKey).toBe('loan_recovery');
    expect(flow.addedVariables).toEqual(['amount', 'loan_id']); // due_date is a custom field here
    expect(flow.agents).toEqual([{ id: agentId, name: 'Recovery Bot' }]);
    expect(flow.issues.filter((i: { severity: string }) => i.severity === 'error')).toEqual([]);
    const greet = flow.draft.nodes.find((n: { id: string }) => n.id === 'greet');
    expect(greet.config.text).toBe(LOAN_TEXTS.greet);
    const log = await request(app).get(`${FLOWS}/${flow.id}`).set(auth(manager));
    expect(log.body.data.draft.variables.map((v: { name: string }) => v.name)).toEqual([
      'amount',
      'loan_id',
      'payment_status',
    ]);
  });

  it('without an agent the AI node is unconfigured; bad agent picks are 422', async () => {
    const res = await request(app)
      .post(FLOWS)
      .set(auth(manager))
      .send({ name: 'Inbound', templateKey: 'inbound_support' });
    expect(res.body.data.issues).toContainEqual(
      expect.objectContaining({ code: 'node_unconfigured', nodeId: 'ai', field: 'config.agentId' }),
    );
    const other = await createTestAccount();
    const foreign = await createAgentDoc(other.account._id, 'Other');
    const bad = await request(app)
      .post(FLOWS)
      .set(auth(manager))
      .send({
        name: 'Bad pick',
        templateKey: 'loan_recovery',
        agentIds: { ai: foreign, greet: agentId },
      });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details).toEqual([
      { path: 'agentIds.ai', message: 'Agent not found' },
      { path: 'agentIds.greet', message: 'Not an AI agent node of this template' },
    ]);
    const blankWithAgents = await request(app)
      .post(FLOWS)
      .set(auth(manager))
      .send({ name: 'Blank agents', agentIds: { ai: agentId } });
    expect(blankWithAgents.status).toBe(422);
    expect(
      (await request(app).post(FLOWS).set(auth(manager)).send({ name: 'X', templateKey: 'nope' }))
        .status,
    ).toBe(422);
  });

  it('every template creates through the API', async () => {
    for (const template of FLOW_TEMPLATES) {
      const res = await request(app)
        .post(FLOWS)
        .set(auth(manager))
        .send({ name: `T ${template.key}`, templateKey: template.key });
      expect(res.status).toBe(201);
    }
  });
});
