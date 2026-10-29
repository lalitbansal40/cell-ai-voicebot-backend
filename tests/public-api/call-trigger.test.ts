import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { FlowGraphSchema } from '../../src/core/engine/schema';
import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { generateApiKey } from '../../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../../src/modules/auth/hmac';
import type { CallManager, StartOutboundCallInput } from '../../src/modules/calls/call.service';
import type { CallRegistry } from '../../src/modules/calls/registry';
import { resolveStartValues } from '../../src/modules/flows/run-values';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard, fund } from '../helpers/calls';
import { ALL_DAY } from '../helpers/campaigns';
import { useTestDb } from '../helpers/db';
import { auth, createAgentDoc, FLOWS, newFlow, sampleGraph, saveGraph } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();

/** The calls the stub line was asked to place (the voice runtime is tested elsewhere). */
const placed: StartOutboundCallInput[] = [];
const manager = {
  startOutboundCall: async (input: StartOutboundCallInput) => {
    placed.push(input);
    const call = await CallModel.create({
      accountId: input.accountId,
      direction: 'outbound',
      provider: 'dryrun',
      from: 'dryrun',
      to: input.to,
      isTest: true,
      charged: false,
      source: input.source,
      contactId: input.contactId,
      startedBy: input.initiatedBy,
      externalRef: input.externalRef ?? null,
      variables: input.variables,
      manualVariables: input.manualVariables ?? null,
      timestamps: { queuedAt: new Date() },
      metrics: emptyCallMetrics(),
      cost: emptyCallCost(),
    });
    return { callId: call._id.toString(), ended: new Promise(() => undefined) };
  },
} as unknown as CallManager;
const app = buildTestApp(
  {},
  {
    calls: {
      manager,
      registry: { liveCalls: () => Promise.resolve([]) } as unknown as CallRegistry,
      textInput: false,
      voiceProvider: 'fake',
    },
  },
);

let t: TestAccount;
let owner: TestUser;
let key: string;
let flowId: string;
let agentId: string;
let contactId: string;

beforeAll(async () => {
  await ensureRateCard();
  t = await createTestAccount();
  owner = await t.addUser('owner');
  await fund(t.account._id);
  // any time of day, no gap between test calls to the same contact
  await AccountModel.updateOne(
    { _id: t.account._id },
    {
      'settings.callingWindow': ALL_DAY,
      'settings.callCaps': { perDay: 100, perWeek: 100, minGapMinutes: 0 },
    },
  );
  const flow = await newFlow(app, owner, 'API variables flow');
  flowId = flow.id;
  const graph = {
    ...sampleGraph(),
    variables: [
      { name: 'due_amount', type: 'number' },
      { name: 'due_date', type: 'date' },
    ],
  };
  const saved = await saveGraph(app, owner, flowId, flow.revision, graph);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: 2 });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  agentId = await createAgentDoc(t.account._id, 'Collector');
  await AiAgentModel.updateOne(
    { _id: agentId },
    { $set: { allowedVariables: ['name', 'due_amount'] } },
  );
  contactId = (
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919000501234',
      name: 'Kiran',
      source: { type: 'manual' },
    })
  )._id.toString();
  key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId: t.account._id,
    name: 'LMS',
    prefix: key.slice(0, 13),
    keyHash: sha256Hex(key),
    scopes: ['calls:write', 'calls:read'],
    createdBy: owner.user._id,
  });
});

const call = (body: object, idem = randomUUID()) =>
  request(app).post('/api/v1/calls').set('X-API-Key', key).set('Idempotency-Key', idem).send(body);

describe('POST /calls with a key', () => {
  it('starts a flow call with variables + externalRef, acting for the key creator', async () => {
    placed.length = 0;
    const idem = randomUUID();
    const res = await call(
      {
        contactId,
        flowId,
        variables: { due_amount: 2500, due_date: '2026-11-05' },
        externalRef: 'loan-9',
      },
      idem,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ externalRef: 'loan-9' });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({
      initiatedBy: owner.user._id.toString(),
      externalRef: 'loan-9',
      manualVariables: { due_amount: '2500', due_date: '2026-11-05' },
    });
    // the same Idempotency-Key never dials twice
    const again = await call(
      {
        contactId,
        flowId,
        variables: { due_amount: 2500, due_date: '2026-11-05' },
        externalRef: 'loan-9',
      },
      idem,
    );
    expect(again.body.data.id).toBe(res.body.data.id);
    expect(placed).toHaveLength(1);
    const found = await request(app).get('/api/v1/calls?externalRef=loan-9').set('X-API-Key', key);
    expect(found.body.data.map((c: { id: string }) => c.id)).toEqual([res.body.data.id]);
  });

  it('refuses variables the flow does not declare or values of the wrong type (422 per key)', async () => {
    const res = await call({ contactId, flowId, variables: { due_amount: 'lots', secret: 'x' } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual([
      'variables.due_amount',
      'variables.secret',
    ]);
  });

  it('accepts only the values an agent uses', async () => {
    placed.length = 0;
    const bad = await call({ contactId, agentId, variables: { loan_id: 'L-1' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].path).toBe('variables.loan_id');
    const good = await call({ contactId, agentId, variables: { due_amount: 900 } });
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    expect(placed[0]?.manualVariables).toEqual({ due_amount: '900' });
  });

  it('caps variables at 50 and externalRef at 100 chars', async () => {
    const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`v${String(i)}`, i]));
    expect((await call({ contactId, flowId, variables: many })).status).toBe(422);
    expect((await call({ contactId, flowId, externalRef: 'x'.repeat(101) })).status).toBe(422);
  });

  it('cannot call another account’s contact', async () => {
    const other = await createTestAccount();
    const theirs = await ContactModel.create({
      accountId: other.account._id,
      phoneE164: '+919000501235',
      source: { type: 'manual' },
    });
    const res = await call({ contactId: theirs._id.toString(), flowId });
    expect(res.status).toBe(404);
    expect(String(new Types.ObjectId())).toHaveLength(24);
  });
});

describe('resolveStartValues overrides', () => {
  it('seeds flow variables for a contact call and refuses others', async () => {
    const graph = {
      ...FlowGraphSchema.parse(sampleGraph()),
      variables: [{ name: 'due_amount', type: 'number' as const }],
    };
    const accountId = t.account._id;
    const ok = await resolveStartValues(accountId, graph, {
      contactId: new Types.ObjectId(contactId),
      overrides: { due_amount: ' 1200 ' },
    });
    expect(ok.seed).toEqual({ due_amount: 1200 });
    expect(ok.contact.display.name).toBe('Kiran');
    await expect(
      resolveStartValues(accountId, graph, {
        contactId: new Types.ObjectId(contactId),
        overrides: { due_amount: 'x', other: '1' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    // without overrides nothing changes for contact calls
    expect(
      (await resolveStartValues(accountId, graph, { contactId: new Types.ObjectId(contactId) }))
        .seed,
    ).toEqual({});
  });
});
