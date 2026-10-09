import { Types } from 'mongoose';
import request, { type Response } from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AI_LIMITS } from '../../src/config/limits';
import { AgentToolCallModel } from '../../src/db/models/agent-tool-call.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { PRODUCTION_APP_ENV } from '../helpers/production-env';
import { json, useStubServer } from '../helpers/stub-server';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const stub = useStubServer();
const extraPorts: number[] = [];
const app = buildTestApp(
  {},
  {
    aiHttp: {
      extraPorts,
      resolve: (host) =>
        host === 'api.public.test'
          ? Promise.resolve(['1.2.3.4'])
          : Promise.reject(new Error('ENOTFOUND')), // never a real address
      dial: (ip) => (ip === '1.2.3.4' ? '127.0.0.1' : ip),
    },
  },
);
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const SECRET = 'sk-live-SUPERSECRET-4321';
const NEW_SECRET = 'sk-live-ROTATED-8765';

let t: TestAccount;
let manager: TestUser;
let viewer: TestUser;
let agentId: string;
/** Every response body seen — checked for secrets at the end. */
const seen: string[] = [];
const keep = (res: Response) => {
  seen.push(JSON.stringify(res.body));
  return res;
};

const base = () => `http://api.public.test:${stub.port}`;
/** Table rows are built before the stub listens — `PORT` is filled in at run time. */
const withPort = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value).replaceAll('PORT', String(stub.port))) as T;
const fnBody = (over: Record<string, unknown> = {}) => ({
  name: 'check_payment',
  description: 'Checks if the customer has paid',
  parameters: [{ name: 'loan_id', type: 'string', description: 'Loan id', required: true }],
  method: 'GET',
  url: `${base()}/status?loan={{args.loan_id}}&phone={{contact.phone}}`,
  headers: [
    { name: 'Authorization', secret: true, value: SECRET },
    { name: 'X-Client', secret: false, value: 'cav' },
  ],
  resultPath: 'data.status',
  ...over,
});
const fnUrl = (id = agentId) => `/api/v1/agents/${id}/functions`;
const addFn = async (body: object, user = manager, id = agentId) =>
  keep(await request(app).post(fnUrl(id)).set(auth(user)).send(body));

beforeAll(async () => {
  extraPorts.push(stub.port);
  t = await createTestAccount({ name: 'Acme Finance' });
  manager = await t.addUser('manager');
  viewer = await t.addUser('viewer');
  const res = await request(app)
    .post('/api/v1/agents')
    .set(auth(manager))
    .send({ name: 'Fn agent' });
  agentId = res.body.data.id;
});

beforeEach(() => stub.reset());

describe('function CRUD', () => {
  let fnId: string;

  it('adds a function; secret values are sealed and never returned', async () => {
    const res = await addFn(fnBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const fn = res.body.data.functions[0];
    fnId = fn.id;
    expect(fn).toMatchObject({
      name: 'check_payment',
      method: 'GET',
      resultPath: 'data.status',
      timeoutMs: 6000,
      headers: [
        { name: 'Authorization', secret: true, value: null, valueHint: '••••4321' },
        { name: 'X-Client', secret: false, value: 'cav', valueHint: null },
      ],
    });
    const stored = await AiAgentModel.findById(agentId).lean();
    const header = stored?.functions[0]?.headers[0];
    expect(header?.sealed).toMatch(/^v1:/);
    expect(header?.sealed).not.toContain(SECRET);
    expect(header?.value).toBeNull();
    const log = await AuditLogModel.findOne({ action: 'agent.updated', 'target.id': agentId })
      .sort({ _id: -1 })
      .lean();
    expect(log?.meta).toEqual({ fields: ['functions.check_payment'], change: 'function_added' });
  });

  it('PATCH keeps a secret with value null, replaces it with a new value', async () => {
    const before = (await AiAgentModel.findById(agentId).lean())?.functions[0]?.headers[0]?.sealed;
    const keepIt = keep(
      await request(app)
        .patch(`${fnUrl()}/${fnId}`)
        .set(auth(manager))
        .send({
          description: 'Checks the payment record',
          headers: [
            { name: 'authorization', secret: true, value: null },
            { name: 'X-Client', secret: false, value: 'cav2' },
          ],
        }),
    );
    expect(keepIt.status, JSON.stringify(keepIt.body)).toBe(200);
    const after = (await AiAgentModel.findById(agentId).lean())?.functions[0];
    expect(after?.headers[0]?.sealed).toBe(before);
    expect(after?.description).toBe('Checks the payment record');
    const log = await AuditLogModel.findOne({ action: 'agent.updated', 'target.id': agentId })
      .sort({ _id: -1 })
      .lean();
    expect(log?.meta).toEqual({
      fields: ['functions.check_payment.description', 'functions.check_payment.headers'],
      change: 'function_updated',
    });

    const rotate = keep(
      await request(app)
        .patch(`${fnUrl()}/${fnId}`)
        .set(auth(manager))
        .send({ headers: [{ name: 'Authorization', secret: true, value: NEW_SECRET }] }),
    );
    expect(rotate.body.data.functions[0].headers).toEqual([
      { name: 'Authorization', secret: true, value: null, valueHint: '••••8765' },
    ]);
    const unknown = keep(
      await request(app)
        .patch(`${fnUrl()}/${fnId}`)
        .set(auth(manager))
        .send({ headers: [{ name: 'X-Other', secret: true, value: null }] }),
    );
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.details[0].path).toBe('headers.0.value');
  });

  it.each([
    [{ name: 'X' }, 'name'],
    [{ name: 'ab' }, 'name'],
    [{ name: 'end_call' }, 'name'],
    [{ name: 'check_payment' }, 'name'],
    [{ description: 'short' }, 'description'],
    [{ method: 'DELETE' }, 'method'],
    [{ url: 'not a url' }, 'url'],
    [{ url: 'http://{{args.loan_id}}.example.com/x' }, 'url'],
    [{ url: `http://api.public.test:PORT/x?{{foo}}` }, 'url'],
    [{ url: `http://api.public.test:PORT/x?{{args.nope}}` }, 'url'],
    [{ method: 'GET', bodyTemplate: '{"a":1}' }, 'bodyTemplate'],
    [{ method: 'POST', bodyTemplate: '{bad json' }, 'bodyTemplate'],
    [{ method: 'POST', bodyTemplate: '"just a string"' }, 'bodyTemplate'],
    [{ method: 'POST', bodyTemplate: '{"a":"{{contact}}"}' }, 'bodyTemplate'],
    [{ headers: [{ name: 'Bad Header', secret: false, value: 'x' }] }, 'headers.0.name'],
    [{ headers: [{ name: 'Host', secret: false, value: 'evil' }] }, 'headers.0.name'],
    [{ headers: [{ name: 'Content-Length', secret: false, value: '1' }] }, 'headers.0.name'],
    [
      {
        headers: [
          { name: 'X-A', secret: false, value: 'x' },
          { name: 'x-a', secret: false, value: 'y' },
        ],
      },
      'headers.1.name',
    ],
    [{ headers: [{ name: 'X-A', secret: false, value: 'a\r\nb' }] }, 'headers.0.value'],
    [{ headers: [{ name: 'X-A', secret: false, value: null }] }, 'headers.0.value'],
    [{ headers: [{ name: 'X-A', secret: true, value: null }] }, 'headers.0.value'],
    [
      { parameters: [{ name: 'kind', type: 'enum', description: '', required: true }] },
      'parameters.0.enumValues',
    ],
    [
      {
        parameters: [
          { name: 'a', type: 'string', description: '', required: true },
          { name: 'a', type: 'number', description: '', required: true },
        ],
        url: `http://api.public.test:PORT/x`,
      },
      'parameters.1.name',
    ],
    [
      {
        parameters: Array.from({ length: 11 }, (_, i) => ({
          name: `p${i}`,
          type: 'string',
          required: false,
        })),
        url: `http://api.public.test:PORT/x`,
      },
      'parameters',
    ],
    [{ resultPath: 'a.b.c.d.e.f' }, 'resultPath'],
    [{ timeoutMs: 500 }, 'timeoutMs'],
  ])('rejects %j (%s)', async (over, path) => {
    const res = await addFn(fnBody({ name: 'table_fn', ...withPort(over) }));
    expect(res.status).toBe(422);
    // schema errors carry the `body.` prefix, service checks don't
    const paths = res.body.error.details.map((d: { path: string }) =>
      d.path.replace(/^body\./, ''),
    );
    expect(paths).toContain(path);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/x',
    'http://api.public.test:22/x',
    'ftp://api.public.test/x',
  ])('refuses %s with FUNCTION_URL_BLOCKED', async (url) => {
    const res = await addFn(fnBody({ name: 'blocked_one', url, parameters: [] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FUNCTION_URL_BLOCKED');
  });

  it('without private hosts, private addresses are refused at save time', async () => {
    const strict = buildTestApp({ AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS: 'false' });
    const res = await request(strict)
      .post(fnUrl())
      .set(auth(manager))
      .send(fnBody({ name: 'private_one', url: 'http://10.0.0.5/x', parameters: [] }));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('FUNCTION_URL_BLOCKED');
  });

  it('production refuses http (https only)', async () => {
    const prod = buildTestApp(PRODUCTION_APP_ENV);
    const http = await request(prod)
      .post(fnUrl())
      .set(auth(manager))
      .send(
        fnBody({
          name: 'plain_http',
          url: 'http://api.example.com/x',
          parameters: [],
          headers: [],
        }),
      );
    expect(http.status).toBe(422);
    expect(http.body.error.code).toBe('FUNCTION_URL_BLOCKED');
    expect(http.body.error.details[0].message).toBe('Only https addresses are allowed');
    const https = await request(prod)
      .post(fnUrl())
      .set(auth(manager))
      .send(
        fnBody({
          name: 'secure_one',
          url: 'https://api.example.com/x',
          parameters: [],
          headers: [],
        }),
      );
    expect(https.status, JSON.stringify(https.body)).toBe(201);
  });

  it('caps functions per agent', async () => {
    const res = await request(app)
      .post('/api/v1/agents')
      .set(auth(manager))
      .send({ name: 'Full agent' });
    const id = res.body.data.id as string;
    await AiAgentModel.updateOne(
      { _id: id },
      {
        $set: {
          functions: Array.from({ length: AI_LIMITS.functionsPerAgent }, (_, i) => ({
            name: `fn_${i}x`,
            description: 'Some function',
            method: 'GET',
            url: 'https://api.example.com/x',
          })),
        },
      },
    );
    const over = await addFn(fnBody({ name: 'one_more' }), manager, id);
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('CONFLICT_INVALID_STATE');
  });

  it('deletes a function', async () => {
    const add = await addFn(fnBody({ name: 'temp_fn', headers: [] }));
    const id = add.body.data.functions.find((f: { name: string }) => f.name === 'temp_fn').id;
    const del = keep(await request(app).delete(`${fnUrl()}/${id}`).set(auth(manager)));
    expect(del.status).toBe(200);
    expect(del.body.data.functions.map((f: { name: string }) => f.name)).not.toContain('temp_fn');
    expect((await request(app).delete(`${fnUrl()}/${id}`).set(auth(manager))).status).toBe(404);
    const log = await AuditLogModel.findOne({ action: 'agent.updated', 'target.id': agentId })
      .sort({ _id: -1 })
      .lean();
    expect(log?.meta).toEqual({ fields: ['functions.temp_fn'], change: 'function_removed' });
  });
});

describe('function test endpoint', () => {
  let fnId: string;
  let contactId: string;
  beforeAll(async () => {
    const res = await addFn(fnBody({ name: 'test_target' }));
    fnId = res.body.data.functions.find((f: { name: string }) => f.name === 'test_target').id;
    const contact = await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919000000001',
      name: 'Asha Verma',
      source: { type: 'manual' },
    });
    contactId = contact._id.toString();
  });
  const test = (body: object, user = manager) =>
    request(app).post(`${fnUrl()}/${fnId}/test`).set(auth(user)).send(body).then(keep);

  it('calls the API with the contact phone and the sealed secret, logs a redacted row', async () => {
    stub.next(json(200, { data: { status: 'paid' } }));
    const res = await test({ args: { loan_id: 'L-77' }, contactId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({
      ok: true,
      httpStatus: 200,
      result: 'paid',
      warnings: [],
      error: null,
    });
    expect(stub.requests[0]?.url).toBe('/status?loan=L-77&phone=%2B919000000001');
    expect(stub.requests[0]?.headers.authorization).toBe(SECRET);
    const row = await AgentToolCallModel.findOne({ tool: 'test_target' }).sort({ _id: -1 }).lean();
    expect(row).toMatchObject({
      source: 'test',
      kind: 'custom',
      status: 'ok',
      httpStatus: 200,
      argsRedacted: { loan_id: 'L-77' },
      resultPreview: 'paid',
      sessionId: null,
    });
    expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000);
  });

  it('uses a test phone, warns about missing values', async () => {
    stub.next(json(200, { data: {} }));
    const res = await test({ args: { loan_id: '9876543210' }, testPhone: '+919000000002' });
    expect(res.body.data).toMatchObject({
      ok: true,
      result: 'null',
      warnings: ['result_path_not_found'],
    });
    expect(stub.requests[0]?.url).toContain('phone=%2B919000000002');
    const row = await AgentToolCallModel.findOne({ tool: 'test_target' }).sort({ _id: -1 }).lean();
    expect(row?.argsRedacted).toEqual({ loan_id: '••••3210' });
    stub.next(json(200, { data: { status: 'x' } }));
    const none = await test({ args: { loan_id: 'L1' } });
    expect(none.body.data.warnings).toEqual(['missing:contact.phone']);
  });

  it('bad arguments never reach the API', async () => {
    const res = await test({ args: { loan_id: 5, extra: true } });
    expect(res.body.data).toMatchObject({
      ok: false,
      error: 'invalid_arguments',
      httpStatus: null,
    });
    expect(res.body.data.details.length).toBeGreaterThan(0);
    expect(stub.requests).toHaveLength(0);
  });

  it('API errors come back as results', async () => {
    stub.next(json(503, {}));
    const res = await test({ args: { loan_id: 'L1' } });
    expect(res.body.data).toMatchObject({ ok: false, error: 'http_503', httpStatus: 503 });
  });

  it("another account's contact → 404", async () => {
    const other = await createTestAccount();
    const c = await ContactModel.create({
      accountId: other.account._id,
      phoneE164: '+919000000003',
      source: { type: 'manual' },
    });
    expect((await test({ args: { loan_id: 'L1' }, contactId: c._id.toString() })).status).toBe(404);
    expect(
      (
        await request(app)
          .post(`${fnUrl()}/${new Types.ObjectId().toString()}/test`)
          .set(auth(manager))
          .send({})
      ).status,
    ).toBe(404);
  });

  it('is rate limited per user (20 / min)', async () => {
    const busy = await t.addUser('admin');
    stub.always(json(200, { data: { status: 'paid' } }));
    for (let i = 0; i < AI_LIMITS.functionTestsPerMinute; i += 1) {
      expect((await test({ args: { loan_id: 'L1' } }, busy)).status).toBe(200);
    }
    const limited = await test({ args: { loan_id: 'L1' } }, busy);
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect((await test({ args: { loan_id: 'L1' } })).status).toBe(200);
  });
});

describe('permissions, isolation and secrecy', () => {
  it('viewers and impersonators cannot change or test functions', async () => {
    const fnId = (await AiAgentModel.findById(agentId).lean())?.functions[0]?._id.toString();
    expect((await addFn(fnBody({ name: 'viewer_fn' }), viewer)).status).toBe(403);
    expect(
      (await request(app).post(`${fnUrl()}/${fnId}/test`).set(auth(viewer)).send({})).status,
    ).toBe(403);
    const owner = await t.addUser('owner');
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    const res = await request(app).post(`${fnUrl()}/${fnId}/test`).set(auth(imp)).send({});
    expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect((await request(app).get(`/api/v1/agents/${agentId}`).set(auth(viewer))).status).toBe(
      200,
    );
  });

  it("another account's agent / function is 404", async () => {
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    const fnId = (await AiAgentModel.findById(agentId).lean())?.functions[0]?._id.toString();
    expect((await addFn(fnBody({ name: 'theirs' }), o)).status).toBe(404);
    expect(
      (await request(app).patch(`${fnUrl()}/${fnId}`).set(auth(o)).send({ timeoutMs: 2000 }))
        .status,
    ).toBe(404);
    expect((await request(app).delete(`${fnUrl()}/${fnId}`).set(auth(o))).status).toBe(404);
    expect((await request(app).post(`${fnUrl()}/${fnId}/test`).set(auth(o)).send({})).status).toBe(
      404,
    );
  });

  it('secret values never appear in responses, audit or tool-call logs', async () => {
    seen.push(
      JSON.stringify((await request(app).get(`/api/v1/agents/${agentId}`).set(auth(viewer))).body),
    );
    seen.push(JSON.stringify((await request(app).get('/api/v1/agents').set(auth(viewer))).body));
    const audit = await AuditLogModel.find({ accountId: t.account._id }).lean();
    const calls = await AgentToolCallModel.find({ accountId: t.account._id }).lean();
    const everything = [...seen, JSON.stringify(audit), JSON.stringify(calls)].join('\n');
    for (const secret of [SECRET, NEW_SECRET, 'SUPERSECRET', 'ROTATED']) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toContain('+919000000001');
  });
});
