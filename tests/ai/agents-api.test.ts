import { Types } from 'mongoose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AI_LIMITS } from '../../src/config/limits';
import * as notify from '../../src/core/realtime/notify';
import { AgentUsageModel } from '../../src/db/models/agent-usage.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { CustomFieldModel } from '../../src/db/models/custom-field.model';
import { KnowledgeBaseModel } from '../../src/db/models/knowledge-base.model';
import { TEMPLATE_KEYS } from '../../src/modules/ai-agents/templates';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/agents';

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
  await CustomFieldModel.create({
    accountId: t.account._id,
    key: 'loan_amount',
    label: 'Loan amount',
    type: 'currency',
  });
});

afterEach(() => vi.restoreAllMocks());

const create = (u: { token: string }, body: object) =>
  request(app).post(URL).set(auth(u)).send(body);
const patch = (u: { token: string }, id: string, body: object) =>
  request(app).patch(`${URL}/${id}`).set(auth(u)).send(body);
const newAgent = async (name: string, templateKey?: string) => {
  const res = await create(manager, { name, ...(templateKey ? { templateKey } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; name: string } & Record<string, unknown>;
};

describe('agents CRUD', () => {
  it('creates a blank agent with defaults, audits and notifies', async () => {
    const spy = vi.spyOn(notify, 'notifyAccount');
    const res = await create(manager, { name: 'Blank one', description: 'Test' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Blank one',
      description: 'Test',
      isActive: true,
      templateKey: null,
      voice: 'coral',
      languageMode: 'auto',
      language: 'hinglish',
      allowedVariables: ['name'],
      model: { textModel: 'gpt-4.1-mini', temperatureTenths: 6, maxOutputTokens: 300 },
      limits: { onCap: 'fallback' },
      knowledge: { knowledgeBaseIds: [], topK: 4, minScoreHundredths: 35 },
      functions: [],
    });
    expect(spy).toHaveBeenCalledWith(t.account._id.toString(), 'agent.updated', {
      agentId: res.body.data.id,
    });
    const log = await AuditLogModel.findOne({
      action: 'agent.created',
      'target.id': res.body.data.id,
    }).lean();
    expect(log?.meta).toEqual({ name: 'Blank one', templateKey: null });
  });

  it('creates from every template (with the mock payment function)', async () => {
    for (const key of TEMPLATE_KEYS) {
      const a = await newAgent(`From ${key}`, key);
      expect(a.templateKey).toBe(key);
      expect((a.persona as string).length).toBeGreaterThan(50);
    }
    const loan = await AiAgentModel.findOne({ templateKey: 'loan_recovery_hinglish' }).lean();
    expect(loan?.functions[0]).toMatchObject({ name: 'check_payment_status', method: 'GET' });
    expect(loan?.functions[0]?.url).toContain(
      '/api/v1/mock/payment-status?phone={{contact.phone}}',
    );
    expect(loan?.guardrails.complianceMode).toBe('recovery');
    const bad = await create(manager, { name: 'Nope', templateKey: 'nope' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('templateKey');
  });

  it('rejects duplicate names case-insensitively, allows reuse after delete', async () => {
    const a = await newAgent('Unique Name');
    const dup = await create(owner, { name: 'unique name' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT_DUPLICATE');
    const other = await newAgent('Other Name');
    expect((await patch(manager, other.id, { name: 'UNIQUE NAME' })).status).toBe(409);
    expect((await patch(manager, a.id, { name: 'Unique name' })).status).toBe(200);

    const del = await request(app).delete(`${URL}/${a.id}`).set(auth(manager));
    expect(del.status).toBe(204);
    expect((await request(app).get(`${URL}/${a.id}`).set(auth(manager))).status).toBe(404);
    expect(await AuditLogModel.countDocuments({ action: 'agent.deleted', 'target.id': a.id })).toBe(
      1,
    );
    expect((await create(manager, { name: 'Unique Name' })).status).toBe(201);
  });

  it('lists with search, active filter, pagination and month spend', async () => {
    const a = await newAgent('Zeta searchable');
    const other = await newAgent('Zeta inactive');
    await request(app).post(`${URL}/${other.id}/deactivate`).set(auth(manager));
    const month = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
    await AgentUsageModel.create({
      accountId: t.account._id,
      agentId: new Types.ObjectId(a.id),
      day: `${month}-01`,
      month,
      spentMicros: 12_345,
      turns: 2,
    });
    const res = await request(app).get(`${URL}?q=zeta&activeOnly=true`).set(auth(viewer));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      name: 'Zeta searchable',
      isActive: true,
      knowledgeBases: 0,
      functions: 0,
      monthSpendMicros: 12_345,
    });
    expect(res.body.meta).toMatchObject({ page: 1, total: 1 });
    const page = await request(app).get(`${URL}?limit=2&page=1`).set(auth(viewer));
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta.total).toBeGreaterThan(2);
    // regex characters are searched literally
    expect((await request(app).get(`${URL}?q=.*`).set(auth(viewer))).body.data).toHaveLength(0);
  });

  it('patches nested objects one level deep and replaces arrays', async () => {
    const a = await newAgent('Patch me', 'loan_recovery_hinglish');
    const res = await patch(manager, a.id, {
      model: { temperatureTenths: 3 },
      guardrails: { neverSay: ['jail'] },
      toneRules: [{ when: 'custom', customWhen: 'customer cries', respond: 'Main samajhta hoon.' }],
      builtInTools: { endCall: { enabled: false } },
      limits: { dailySpendCapMicros: 5_000_000 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.model).toEqual({
      textModel: 'gpt-4.1-mini',
      temperatureTenths: 3,
      maxOutputTokens: 300,
    });
    expect(res.body.data.guardrails).toMatchObject({
      neverSay: ['jail'],
      complianceMode: 'recovery',
    });
    expect(res.body.data.toneRules).toEqual([
      { when: 'custom', customWhen: 'customer cries', respond: 'Main samajhta hoon.' },
    ]);
    expect(res.body.data.builtInTools.endCall.enabled).toBe(false);
    expect(res.body.data.builtInTools.savePromiseToPay).toEqual({
      enabled: true,
      maxDaysAhead: 15,
    });
    expect(res.body.data.limits).toMatchObject({
      dailySpendCapMicros: 5_000_000,
      onCap: 'fallback',
    });

    const log = await AuditLogModel.findOne({ action: 'agent.updated', 'target.id': a.id }).lean();
    expect(log?.meta).toEqual({
      fields: ['builtInTools', 'guardrails', 'limits', 'model', 'toneRules'],
    });
  });

  it('never puts persona text in the audit log', async () => {
    const a = await newAgent('Secret persona');
    const persona = 'TOP-SECRET persona text that must stay out of logs';
    expect((await patch(manager, a.id, { persona })).status).toBe(200);
    const logs = await AuditLogModel.find({ 'target.id': a.id }).lean();
    expect(JSON.stringify(logs)).not.toContain('TOP-SECRET');
  });

  it('duplicates as an inactive copy with unique names', async () => {
    const a = await newAgent('Dup source', 'payment_reminder');
    await request(app).post(`${URL}/${a.id}/activate`).set(auth(manager));
    const one = await request(app).post(`${URL}/${a.id}/duplicate`).set(auth(manager));
    expect(one.status).toBe(201);
    expect(one.body.data).toMatchObject({
      name: 'Dup source (copy)',
      isActive: false,
      templateKey: 'payment_reminder',
    });
    expect(one.body.data.functions[0].id).not.toBe(
      (await AiAgentModel.findById(a.id).lean())?.functions[0]?._id.toString(),
    );
    const two = await request(app).post(`${URL}/${a.id}/duplicate`).set(auth(manager));
    expect(two.body.data.name).toBe('Dup source (copy 2)');
    const log = await AuditLogModel.findOne({
      action: 'agent.duplicated',
      'target.id': one.body.data.id,
    }).lean();
    expect(log?.meta).toEqual({ sourceAgentId: a.id, name: 'Dup source (copy)' });
  });

  it('activates / deactivates (audits only real changes)', async () => {
    const a = await newAgent('Toggle');
    const off0 = await request(app).post(`${URL}/${a.id}/deactivate`).set(auth(manager));
    expect(off0.body.data.isActive).toBe(false);
    const on = await request(app).post(`${URL}/${a.id}/activate`).set(auth(manager));
    expect(on.body.data.isActive).toBe(true);
    await request(app).post(`${URL}/${a.id}/activate`).set(auth(manager));
    expect(
      await AuditLogModel.countDocuments({ action: 'agent.activated', 'target.id': a.id }),
    ).toBe(1);
    const off = await request(app).post(`${URL}/${a.id}/deactivate`).set(auth(manager));
    expect(off.body.data.isActive).toBe(false);
    expect(
      await AuditLogModel.countDocuments({ action: 'agent.deactivated', 'target.id': a.id }),
    ).toBe(2);
  });

  it('hides secret header values (hint only)', async () => {
    const a = await newAgent('Headers');
    await AiAgentModel.updateOne(
      { _id: a.id },
      {
        $push: {
          functions: {
            name: 'lookup',
            description: 'Look up',
            parameters: [],
            method: 'GET',
            url: 'https://api.example.com/x',
            headers: [
              { name: 'Authorization', secret: true, sealed: 'v1:a:b:c', valueHint: '••••1234' },
              { name: 'X-Plain', secret: false, value: 'plain' },
            ],
            timeoutMs: 6000,
          },
        },
      },
    );
    const res = await request(app).get(`${URL}/${a.id}`).set(auth(viewer));
    expect(res.body.data.functions[0].headers).toEqual([
      { name: 'Authorization', secret: true, value: null, valueHint: '••••1234' },
      { name: 'X-Plain', secret: false, value: 'plain', valueHint: null },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('v1:a:b:c');
  });
});

describe('validation', () => {
  let id: string;
  beforeAll(async () => {
    id = (await newAgent('Validation target')).id;
  });

  it.each([
    [{ persona: 'Hi {{loan_amount}}' }, 'persona'],
    [{ openingLine: 'Hello {{ unknown_x }}' }, 'openingLine'],
    [{ fallback: { aiFailed: 'Sorry {{loan_amount}}' } }, 'fallback.aiFailed'],
    [{ guardrails: { disclosureLine: 'I am {{loan_amount}}' } }, 'guardrails.disclosureLine'],
    [{ toneRules: [{ when: 'angry', respond: '{{loan_amount}}' }] }, 'toneRules.0.respond'],
    [{ allowedVariables: ['name', 'not_a_field'] }, 'allowedVariables.1'],
    [{ model: { textModel: 'gpt-unknown' } }, 'model.textModel'],
    [
      { knowledge: { knowledgeBaseIds: [new Types.ObjectId().toString()] } },
      'knowledge.knowledgeBaseIds',
    ],
  ])('rejects %j at %s', async (body, path) => {
    const res = await patch(manager, id, body);
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toContain(path);
  });

  it.each([
    [{}],
    [{ unknown: 1 }],
    [{ name: '' }],
    [{ persona: 'x'.repeat(AI_LIMITS.personaMaxChars + 1) }],
    [{ toneRules: [{ when: 'custom', respond: 'x' }] }],
    [{ voice: 'robot' }],
    [{ model: { temperatureTenths: 13 } }],
    [{ knowledge: { knowledgeBaseIds: ['a', 'b', 'c', 'd'] } }],
  ])('schema rejects %j', async (body) => {
    expect((await patch(manager, id, body)).status).toBe(422);
  });

  it('accepts allowed custom fields, {{company}} and own knowledge bases', async () => {
    const kb = await KnowledgeBaseModel.create({ accountId: t.account._id, name: 'FAQ' });
    const other = await createTestAccount();
    const foreignKb = await KnowledgeBaseModel.create({
      accountId: other.account._id,
      name: 'FAQ',
    });
    const ok = await patch(manager, id, {
      allowedVariables: ['name', 'loan_amount'],
      persona: '{{company}} ke liye {{name}} se {{loan_amount}} ki baat',
      knowledge: { knowledgeBaseIds: [kb._id.toString(), kb._id.toString()] },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.knowledge.knowledgeBaseIds).toEqual([kb._id.toString()]);
    const foreign = await patch(manager, id, {
      knowledge: { knowledgeBaseIds: [foreignKb._id.toString()] },
    });
    expect(foreign.status).toBe(422);
  });

  it('caps agents per account', async () => {
    const capped = await createTestAccount();
    const o = await capped.addUser('owner');
    await AiAgentModel.insertMany(
      Array.from({ length: AI_LIMITS.agentsPerAccount }, (_, i) => ({
        accountId: capped.account._id,
        name: `A${i}`,
        model: { textModel: 'gpt-4.1-mini' },
      })),
    );
    const res = await create(o, { name: 'One too many' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_INVALID_STATE');
    const any = await AiAgentModel.findOne({ accountId: capped.account._id }).lean();
    expect(
      (await request(app).post(`${URL}/${any?._id.toString()}/duplicate`).set(auth(o))).status,
    ).toBe(409);
  });
});

describe('permissions and isolation', () => {
  it('viewer and agent roles are read-only', async () => {
    const a = await newAgent('Perm target');
    for (const u of [viewer, agentUser]) {
      expect((await request(app).get(`${URL}/${a.id}`).set(auth(u))).status).toBe(200);
      expect((await create(u, { name: 'Nope' })).status).toBe(403);
      expect((await patch(u, a.id, { persona: 'x' })).status).toBe(403);
      expect((await request(app).delete(`${URL}/${a.id}`).set(auth(u))).status).toBe(403);
      expect((await request(app).post(`${URL}/${a.id}/activate`).set(auth(u))).status).toBe(403);
    }
    expect((await request(app).get(URL)).status).toBe(401);
  });

  it('impersonation can read but not write', async () => {
    const a = await newAgent('Imp target');
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    expect((await request(app).get(`${URL}/${a.id}`).set(auth(imp))).status).toBe(200);
    const res = await patch(imp, a.id, { persona: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect((await create(imp, { name: 'Imp new' })).body.error.code).toBe(
      'AUTH_IMPERSONATION_BLOCKED',
    );
  });

  it('suspended accounts are read-only', async () => {
    const s = await createTestAccount({ status: 'suspended' });
    const so = await s.addUser('owner');
    expect((await request(app).get(URL).set(auth(so))).status).toBe(200);
    expect((await create(so, { name: 'Blocked' })).status).toBe(403);
  });

  it("another account's agent is 404 everywhere", async () => {
    const a = await newAgent('Isolated');
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    expect((await request(app).get(`${URL}/${a.id}`).set(auth(o))).status).toBe(404);
    expect((await patch(o, a.id, { persona: 'x' })).status).toBe(404);
    expect((await request(app).delete(`${URL}/${a.id}`).set(auth(o))).status).toBe(404);
    expect((await request(app).post(`${URL}/${a.id}/duplicate`).set(auth(o))).status).toBe(404);
    expect(
      (await request(app).post(`${URL}/${a.id}/compile-preview`).set(auth(o)).send({})).status,
    ).toBe(404);
    expect((await request(app).get(`${URL}/${a.id}/usage`).set(auth(o))).status).toBe(404);
    expect((await request(app).get(URL).set(auth(o))).body.data).toHaveLength(0);
    expect((await request(app).get(`${URL}/not-an-id`).set(auth(o))).status).toBe(422);
  });
});

describe('templates, catalog, preview and usage', () => {
  it('lists templates and the catalog (incl. custom fields)', async () => {
    const tpl = await request(app).get(`${URL}/templates`).set(auth(viewer));
    expect(tpl.status).toBe(200);
    expect(tpl.body.data.map((x: { key: string }) => x.key)).toEqual([...TEMPLATE_KEYS]);
    const cat = await request(app).get(`${URL}/catalog`).set(auth(viewer));
    expect(cat.status).toBe(200);
    expect(cat.body.data).toMatchObject({
      provider: 'fake',
      textModels: ['gpt-4.1-mini'],
      defaultTextModel: 'gpt-4.1-mini',
      limits: { functionsPerAgent: 10, kbPerAgent: 3 },
    });
    expect(cat.body.data.variables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'loan_amount', type: 'currency' })]),
    );
    expect(cat.body.data.voices).toContain('coral');
  });

  it('previews with a contact (formatted values) or manual variables', async () => {
    const a = await newAgent('Preview', 'loan_recovery_hinglish');
    await patch(manager, a.id, { allowedVariables: ['name', 'loan_amount'] });
    const contact = await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919876500123',
      name: 'Ravi',
      source: { type: 'manual' },
      variables: { loan_amount: 12_500_000_000 },
    });
    const res = await request(app)
      .post(`${URL}/${a.id}/compile-preview`)
      .set(auth(viewer))
      .send({ contactId: contact._id.toString(), channel: 'voice' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.variables).toEqual({ name: 'Ravi', loan_amount: '₹12,500.00' });
    expect(res.body.data.instructions).toContain('Acme Finance');
    expect(res.body.data.instructions).toContain('This is a phone call');
    expect(res.body.data.openingLine).toBe(
      'Namaste Ravi ji, main Acme Finance se bol raha hoon. Kya aapse do minute baat ho sakti hai?',
    );
    expect(res.body.data.tools.map((x: { name: string }) => x.name)).toContain(
      'check_payment_status',
    );

    const manual = await request(app)
      .post(`${URL}/${a.id}/compile-preview`)
      .set(auth(viewer))
      .send({ variables: { name: 'Asha', other: 'ignored' } });
    expect(manual.body.data.variables).toEqual({ name: 'Asha', loan_amount: '' });
    expect(manual.body.data.warnings).toEqual([]);
    const missing = await request(app)
      .post(`${URL}/${a.id}/compile-preview`)
      .set(auth(viewer))
      .send({});
    expect(missing.body.data.warnings).toEqual(['missing_variable:name']);
    const foreign = await request(app)
      .post(`${URL}/${a.id}/compile-preview`)
      .set(auth(viewer))
      .send({ contactId: new Types.ObjectId().toString() });
    expect(foreign.status).toBe(404);
  });

  it('reports today and month usage', async () => {
    const a = await newAgent('Usage');
    const empty = await request(app).get(`${URL}/${a.id}/usage`).set(auth(viewer));
    expect(empty.body.data.today).toMatchObject({ spentMicros: 0, turns: 0 });
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    await AgentUsageModel.create({
      accountId: t.account._id,
      agentId: new Types.ObjectId(a.id),
      day,
      month: day.slice(0, 7),
      spentMicros: 900,
      turns: 3,
      inputTokens: 100,
      outputTokens: 20,
    });
    const res = await request(app).get(`${URL}/${a.id}/usage`).set(auth(viewer));
    expect(res.body.data).toEqual({
      today: { day, spentMicros: 900, turns: 3 },
      month: {
        month: day.slice(0, 7),
        spentMicros: 900,
        turns: 3,
        inputTokens: 100,
        outputTokens: 20,
      },
    });
  });
});
