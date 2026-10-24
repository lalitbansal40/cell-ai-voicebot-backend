import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { CALL_LIMITS } from '../../src/config/limits';
import { createFakeProvider } from '../../src/core/ai';
import { WsTicketService } from '../../src/core/realtime/ws-tickets';
import { createMediaServer } from '../../src/core/telephony/media-server';
import { FakeTts } from '../../src/core/voice/providers';
import { TtsCache } from '../../src/core/voice/tts-cache';
import { AccountModel } from '../../src/db/models/account.model';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { CallEventModel } from '../../src/db/models/call-event.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { RoleModel } from '../../src/db/models/role.model';
import { TranscriptTurnModel } from '../../src/db/models/transcript-turn.model';
import { CallManager } from '../../src/modules/calls/call.service';
import { CallRegistry } from '../../src/modules/calls/registry';
import type { CallIO } from '../../src/modules/calls/session';
import { CallControlBus } from '../../src/modules/whatsapp-calling/bus';
import { buildOpenApiDocument } from '../../src/openapi';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { ensureRateCard, fund, scriptOf } from '../helpers/calls';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { FLOWS, auth, createAgentDoc, newFlow, sampleGraph, saveGraph } from '../helpers/flows';
import { flushPrefix, requireRedis, uniquePrefix } from '../helpers/redis';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-callsapi-'));
const prefix = `${uniquePrefix('callsapi')}:`;
const BASE = '/api/v1/calls';
const silent = createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });

let redis: Redis;
let server: Server;
let app: ReturnType<typeof buildTestApp>;
let media: ReturnType<typeof createMediaServer>;
let manager: CallManager;
let registry: CallRegistry;
let t: TestAccount;
let owner: TestUser;
let viewer: TestUser;
let agentUser: TestUser;
let flowId: string;
let agentId: string;
let contactId: string;

/** The script of every API test call: waits until the call ends. */
const waitLong = (io: CallIO) =>
  new Promise<void>((resolve) => {
    const check = () => (io.ended ? resolve() : io.clock.setTimeout(check, 100));
    check();
  });

beforeAll(async () => {
  redis = (await requireRedis()).client;
  await ensureRateCard();
  const tickets = new WsTicketService(redis, `${prefix}wst:`);
  registry = new CallRegistry(redis, prefix);
  manager = new CallManager({
    logger: silent,
    registry,
    tts: new TtsCache({ tts: new FakeTts(), storage }),
    storage,
    recordingDir,
    tickets,
    scriptFor: () =>
      Promise.resolve({ script: scriptOf(waitLong), voice: 'alloy', language: 'hi' }),
  });
  app = buildTestApp(
    {},
    {
      storage,
      aiProvider: createFakeProvider(),
      calls: { manager, registry, textInput: true, voiceProvider: 'fake' },
    },
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  media = createMediaServer({
    server,
    tickets,
    logger: silent,
    textInput: true,
    attach: manager.attach,
  });
  t = await createTestAccount({ name: 'Acme Finance' });
  owner = await t.addUser('owner');
  viewer = await t.addUser('viewer');
  agentUser = await t.addUser('agent');
  await fund(t.account._id);
  const flow = await newFlow(app, owner, 'Calls API flow');
  flowId = flow.id;
  agentId = await createAgentDoc(t.account._id, 'Helper');
  await AiAgentModel.updateOne({ _id: agentId }, { $set: { allowedVariables: ['name'] } });
  const saved = await saveGraph(app, owner, flowId, flow.revision, sampleGraph());
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const published = await request(app)
    .post(`${FLOWS}/${flowId}/publish`)
    .set(auth(owner))
    .send({ revision: 2 });
  expect(published.status, JSON.stringify(published.body)).toBe(201);
  contactId = (
    await ContactModel.create({
      accountId: t.account._id,
      phoneE164: '+919000400012',
      name: 'Asha Verma',
      source: { type: 'manual' },
    })
  )._id.toString();
});
afterAll(async () => {
  await manager.shutdown();
  await media.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await flushPrefix(redis, prefix);
  redis.disconnect();
  rmSync(recordingDir, { recursive: true, force: true });
});

const web = (u: { token: string }, body: Record<string, unknown>) =>
  request(app).post(`${BASE}/web`).set(auth(u)).send(body);
/** Calls nobody connects to: cancel them so the per-account limit stays free. */
const cancel = async (callId: string) => {
  await CallModel.updateOne(
    { _id: callId },
    { $set: { status: 'canceled', endReason: 'canceled' } },
  );
  await registry.unregister(callId, t.account._id.toString());
  await manager.releaseLease(callId);
};

describe('POST /calls/web', () => {
  it('starts a published flow call with a contact: call view, media ticket, audit; the test phone never comes back', async () => {
    const res = await web(owner, { flowId, contactId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const data = res.body.data;
    expect(data).toMatchObject({
      wsPath: '/ws/media',
      textInput: true,
      voice: 'fake',
      call: {
        status: 'queued',
        isTest: true,
        provider: 'webcall',
        source: { kind: 'flow', flowId, flowVersionRef: 1, name: 'Calls API flow' },
        contact: { id: contactId, name: 'Asha Verma' },
        startedBy: { id: owner.user._id.toString() },
        recording: null,
      },
    });
    expect(data.mediaTicket).toMatch(/^wst_/);
    expect(JSON.stringify(data)).not.toContain('9000400012');
    expect(
      await AuditLogModel.exists({ action: 'call.test_started', 'target.id': data.call.id }),
    ).toBeTruthy();
    await cancel(data.call.id);
  });

  it('draft / version numbers, agents, typed values and the test phone', async () => {
    const draft = await web(owner, {
      flowId,
      version: 'draft',
      variables: { name: 'Typed' },
      testPhone: '+919000400017',
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.data.call.source.flowVersionRef).toBe('draft');
    expect(draft.body.data.call.variables).toMatchObject({ name: 'Typed', phone_last4: '0017' });
    expect(JSON.stringify(draft.body)).not.toContain('+919000400017');
    await cancel(draft.body.data.call.id);
    const v1 = await web(owner, { flowId, version: 1 });
    expect(v1.body.data.call.source.flowVersionRef).toBe(1);
    await cancel(v1.body.data.call.id);
    const agent = await web(agentUser, { agentId, variables: { name: 'Ravi' } });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    expect(agent.body.data.call).toMatchObject({
      source: { kind: 'agent', agentId, name: 'Helper' },
      variables: { name: 'Ravi' },
    });
    await cancel(agent.body.data.call.id);
    const byContact = await web(owner, { agentId, contactId });
    expect(byContact.body.data.call.variables).toEqual({ name: 'Asha Verma' });
    await cancel(byContact.body.data.call.id);
  });

  it('validations: flow or agent, contact or typed values, draft errors, missing version, off agents, unknown variables', async () => {
    const caller = await t.addUser('admin'); // own rate-limit bucket
    const codes = async (body: Record<string, unknown>): Promise<unknown[]> => {
      const res = await web(caller, body);
      const error = (res.body as { error?: { code: string; details?: { path: string }[] } }).error;
      return [res.status, error?.code, error?.details?.[0]?.path];
    };
    expect(await codes({})).toEqual([422, 'VALIDATION_FAILED', 'body.flowId']);
    expect(await codes({ flowId, agentId })).toEqual([422, 'VALIDATION_FAILED', 'body.flowId']);
    expect(await codes({ agentId, version: 1 })).toEqual([
      422,
      'VALIDATION_FAILED',
      'body.version',
    ]);
    expect(await codes({ flowId, contactId, variables: { name: 'x' } })).toEqual([
      422,
      'VALIDATION_FAILED',
      'body.contactId',
    ]);
    expect((await codes({ flowId, version: 9 }))[0]).toBe(404);
    expect((await codes({ flowId, variables: { nope: 'x' } }))[0]).toBe(422);
    expect(await codes({ agentId, variables: { amount: '5' } })).toEqual([
      422,
      'VALIDATION_FAILED',
      'variables.amount',
    ]);
    const broken = await newFlow(app, owner, 'Broken flow');
    const graph = sampleGraph();
    graph.edges = graph.edges.slice(0, 2); // steps without exits
    await saveGraph(app, owner, broken.id, broken.revision, graph);
    expect((await codes({ flowId: broken.id, version: 'draft' }))[1]).toBe('FLOW_INVALID');
    expect((await codes({ flowId: broken.id }))[1]).toBe('CONFLICT_INVALID_STATE'); // nothing published
    const off = await createAgentDoc(t.account._id, 'Off agent', false);
    expect(await codes({ agentId: off })).toEqual([422, 'VALIDATION_FAILED', 'agentId']);
  });

  it('permissions, impersonation, other accounts, suspended accounts and the wallet', async () => {
    expect((await web(viewer, { flowId })).status).toBe(403);
    const noFlows = await RoleModel.create({
      accountId: t.account._id,
      key: `calls-only-${String(Date.now())}`,
      name: 'Calls only',
      permissions: ['calls.trigger', 'calls.read'],
      isSystem: false,
    });
    const limited = await t.addUser('viewer', { roleId: noFlows._id });
    expect((await web(limited, { flowId })).status).toBe(403);
    expect((await web(limited, { agentId })).status).toBe(403);
    const imp = await tokenFor(owner.user, {
      sid: 'imp_calls',
      imp: new Types.ObjectId().toString(),
    });
    const blocked = await web({ token: imp }, { flowId });
    expect(blocked.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');

    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect((await web(stranger, { flowId })).status).toBe(404);
    expect((await web(stranger, { agentId })).status).toBe(404);
    await fund(other.account._id);
    const otherAgent = await createAgentDoc(other.account._id, 'Theirs');
    expect((await web(stranger, { agentId: otherAgent, contactId })).status).toBe(404);

    const poor = await createTestAccount();
    const poorOwner = await poor.addUser('owner');
    const poorAgent = await createAgentDoc(poor.account._id, 'Poor');
    const broke = await web(poorOwner, { agentId: poorAgent });
    expect([broke.status, broke.body.error.code]).toEqual([422, 'WALLET_INSUFFICIENT_BALANCE']);
    expect(await CallModel.countDocuments({ accountId: poor.account._id })).toBe(0);

    await AccountModel.updateOne({ _id: poor.account._id }, { $set: { status: 'suspended' } });
    expect((await web(poorOwner, { agentId: poorAgent })).status).toBe(403);
  });

  it(`${String(CALL_LIMITS.concurrentPerAccount)} live calls per account → 429 CALL_LIMIT_REACHED; ${String(CALL_LIMITS.webCallsPerMinutePerUser)} / min / user → 429 RATE_LIMITED`, async () => {
    const busy = await createTestAccount();
    const busyOwner = await busy.addUser('owner');
    await fund(busy.account._id, 2_000_000_000);
    const busyAgent = await createAgentDoc(busy.account._id, 'Busy');
    const statuses: number[] = [];
    const codes: string[] = [];
    for (let i = 0; i <= CALL_LIMITS.webCallsPerMinutePerUser; i += 1) {
      const res = await web(busyOwner, { agentId: busyAgent });
      statuses.push(res.status);
      codes.push(res.body.error?.code ?? 'ok');
    }
    expect(statuses.slice(0, CALL_LIMITS.concurrentPerAccount)).toEqual(
      Array(CALL_LIMITS.concurrentPerAccount).fill(201),
    );
    expect(codes[CALL_LIMITS.concurrentPerAccount]).toBe('CALL_LIMIT_REACHED');
    expect(codes.at(-1)).toBe('RATE_LIMITED');
    for (const c of await CallModel.find({ accountId: busy.account._id }).lean()) {
      await registry.unregister(c._id.toString(), busy.account._id.toString());
      await manager.releaseLease(c._id.toString());
    }
  });
});

/** Opens the media socket like the browser and answers. */
const connect = (url: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'call.ready', sampleRate: 24_000 }));
      resolve(ws);
    });
    ws.once('error', reject);
  });

describe('a live call through the API and /ws/media', () => {
  it('ws client attaches; /calls/active lists it; a hangup from another tab ends it (audited); 409 afterwards', async () => {
    const caller = await t.addUser('admin');
    const started = await web(caller, { flowId, contactId });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const { call, mediaTicket, wsPath } = started.body.data;
    const port = (server.address() as AddressInfo).port;
    const ws = await connect(
      `ws://127.0.0.1:${String(port)}${wsPath as string}?ticket=${mediaTicket as string}`,
    );
    const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
    await vi.waitFor(
      async () => expect((await CallModel.findById(call.id).lean())?.status).toBe('in_progress'),
      { timeout: 10_000 },
    );
    const active = await request(app).get(`${BASE}/active`).set(auth(viewer));
    expect(active.body.data.map((c: { id: string }) => c.id)).toContain(call.id);
    expect(
      (
        await request(app)
          .post(`${BASE}/${call.id as string}/hangup`)
          .set(auth(viewer))
      ).status,
    ).toBe(403);
    const hung = await request(app)
      .post(`${BASE}/${call.id as string}/hangup`)
      .set(auth(agentUser));
    expect(hung.status, JSON.stringify(hung.body)).toBe(200);
    expect(hung.body.data).toMatchObject({ status: 'completed', endReason: 'customer_hangup' });
    expect(await closed).toBeGreaterThan(0);
    expect(
      await AuditLogModel.exists({ action: 'call.hung_up_remotely', 'target.id': call.id }),
    ).toBeTruthy();
    const again = await request(app)
      .post(`${BASE}/${call.id as string}/hangup`)
      .set(auth(owner));
    expect([again.status, again.body.error.code]).toEqual([409, 'CALL_NOT_ACTIVE']);
    expect((await request(app).get(`${BASE}/active`).set(auth(owner))).body.data).toEqual([]);
  });
});

describe('reading calls', () => {
  let ids: string[] = [];
  beforeAll(async () => {
    const base = {
      accountId: t.account._id,
      direction: 'outbound',
      provider: 'webcall',
      from: 'webcall',
      to: 'webcall:x',
      isTest: true,
      startedBy: owner.user._id,
      variables: { name: 'Asha Verma' },
      metrics: emptyCallMetrics(),
      cost: { ...emptyCallCost(), totalMicros: 240_000 },
    };
    const docs = await CallModel.insertMany<Record<string, unknown>>([
      {
        ...base,
        source: { kind: 'flow', flowId: new Types.ObjectId(flowId), flowVersionRef: 1 },
        contactId,
        status: 'completed',
        endReason: 'hangup_node',
        disposition: 'paid',
        createdAt: new Date('2026-10-01T10:00:00Z'),
        timestamps: { queuedAt: new Date('2026-10-01T10:00:00Z') },
        recording: { fileKey: 'calls/rec-1.wav', durationSec: 6, sizeBytes: 1000, format: 'wav' },
      },
      {
        ...base,
        source: { kind: 'agent', agentId: new Types.ObjectId(agentId) },
        contactId: null,
        status: 'failed',
        endReason: 'ai_failed',
        createdAt: new Date('2026-10-02T10:00:00Z'),
        timestamps: { queuedAt: new Date('2026-10-02T10:00:00Z') },
      },
      {
        ...base,
        source: { kind: 'flow', flowId: new Types.ObjectId(flowId), flowVersionRef: 'draft' },
        contactId,
        status: 'completed',
        endReason: 'customer_hangup',
        isTest: false,
        createdAt: new Date('2026-10-03T10:00:00Z'),
        timestamps: { queuedAt: new Date('2026-10-03T10:00:00Z') },
      },
    ]);
    ids = docs.map((d) => String(d._id));
    await storage.put('calls/rec-1.wav', Buffer.from('RIFF'), { contentType: 'audio/wav' });
    await TranscriptTurnModel.create([
      {
        accountId: t.account._id,
        callId: ids[0],
        seq: 2,
        speaker: 'customer',
        text: '[1]',
        startMs: 3000,
        endMs: 3000,
        source: 'dtmf',
      },
      {
        accountId: t.account._id,
        callId: ids[0],
        seq: 1,
        speaker: 'bot',
        text: 'Namaste',
        startMs: 0,
        endMs: 2000,
        source: 'tts',
        interrupted: true,
      },
    ]);
    await CallEventModel.create([
      {
        accountId: t.account._id,
        callId: ids[0],
        seq: 1,
        type: 'status',
        data: { status: 'ringing' },
        at: new Date(),
      },
      { accountId: t.account._id, callId: ids[0], seq: 2, type: 'dtmf', data: {}, at: new Date() },
    ]);
  });

  it('list: newest first, cursor pages, filters, contact name search; every role with calls.read', async () => {
    const list = async (query: string, u: TestUser = viewer) => {
      const res = await request(app).get(`${BASE}?${query}`).set(auth(u));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as {
        data: { id: string }[];
        meta: { hasMore: boolean; nextCursor: string | null };
      };
    };
    const seeded = (rows: { id: string }[]) =>
      rows.map((r) => r.id).filter((id) => ids.includes(id));
    const first = await list('limit=1&to=2026-10-04T00:00:00Z');
    expect(seeded(first.data)).toEqual([ids[2]]);
    expect(first.meta.hasMore).toBe(true);
    const second = await list(
      `limit=1&to=2026-10-04T00:00:00Z&cursor=${first.meta.nextCursor ?? ''}`,
    );
    expect(seeded(second.data)).toEqual([ids[1]]);
    expect(seeded((await list('status=failed')).data)).toEqual([ids[1]]);
    expect(seeded((await list('status=completed,failed&to=2026-10-04T00:00:00Z')).data)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
    expect(seeded((await list(`agentId=${agentId}`)).data)).toEqual([ids[1]]);
    expect(seeded((await list(`flowId=${flowId}&to=2026-10-04T00:00:00Z`)).data)).toEqual([
      ids[2],
      ids[0],
    ]);
    expect(seeded((await list('isTest=false')).data)).toEqual([ids[2]]);
    expect(seeded((await list(`contactId=${contactId}&to=2026-10-04T00:00:00Z`)).data)).toEqual([
      ids[2],
      ids[0],
    ]);
    expect(seeded((await list('q=asha&to=2026-10-04T00:00:00Z')).data)).toEqual([ids[2], ids[0]]);
    expect(seeded((await list('q=nobody')).data)).toEqual([]);
    expect(
      seeded((await list(`q=asha&contactId=${new Types.ObjectId().toString()}`)).data),
    ).toEqual([]);
    expect(seeded((await list('from=2026-10-01T12:00:00Z&to=2026-10-02T12:00:00Z')).data)).toEqual([
      ids[1],
    ]);
    const bad = await request(app)
      .get(`${BASE}?from=2026-10-05T00:00:00Z&to=2026-10-01T00:00:00Z`)
      .set(auth(viewer));
    expect(bad.status).toBe(422);
    expect((await request(app).get(`${BASE}?cursor=nope`).set(auth(viewer))).status).toBe(422);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect(seeded((await list('', stranger)).data)).toEqual([]);
  });

  it('detail, transcript (in order), events; 404 across accounts', async () => {
    const detail = await request(app)
      .get(`${BASE}/${ids[0] ?? ''}`)
      .set(auth(viewer));
    expect(detail.body.data).toMatchObject({
      id: ids[0],
      disposition: 'paid',
      cost: { totalMicros: 240_000 },
      recording: { durationSec: 6, sizeBytes: 1000 },
      contact: { name: 'Asha Verma' },
    });
    expect(JSON.stringify(detail.body)).not.toContain('fileKey');
    const transcript = await request(app)
      .get(`${BASE}/${ids[0] ?? ''}/transcript`)
      .set(auth(viewer));
    expect(transcript.body.data.map((x: { text: string }) => x.text)).toEqual(['Namaste', '[1]']);
    expect(transcript.body.data[0]).toMatchObject({
      interrupted: true,
      source: 'tts',
      language: null,
    });
    const events = await request(app)
      .get(`${BASE}/${ids[0] ?? ''}/events`)
      .set(auth(viewer));
    expect(events.body.data.map((e: { type: string }) => e.type)).toEqual(['status', 'dtmf']);
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    for (const suffix of ['', '/transcript', '/events', '/recording']) {
      expect(
        (
          await request(app)
            .get(`${BASE}/${ids[0] ?? ''}${suffix}`)
            .set(auth(stranger))
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await request(app)
          .post(`${BASE}/${ids[0] ?? ''}/hangup`)
          .set(auth(stranger))
      ).status,
    ).toBe(404);
    expect((await request(app).get(`${BASE}/not-an-id`).set(auth(viewer))).status).toBe(422);
  });

  it('recording: signed 5 min link for calls.listen (audited every time); 404 without one; 403 for viewers', async () => {
    expect(
      (
        await request(app)
          .get(`${BASE}/${ids[0] ?? ''}/recording`)
          .set(auth(viewer))
      ).status,
    ).toBe(403);
    const res = await request(app)
      .get(`${BASE}/${ids[0] ?? ''}/recording`)
      .set(auth(agentUser));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.url).toContain('calls');
    expect(res.body.data.durationSec).toBe(6);
    const ttl = Date.parse(res.body.data.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(CALL_LIMITS.recordingUrlTtlSec * 1000 - 5000);
    expect(ttl).toBeLessThanOrEqual(CALL_LIMITS.recordingUrlTtlSec * 1000);
    expect(
      await AuditLogModel.countDocuments({
        action: 'call.recording_accessed',
        'target.id': ids[0],
      }),
    ).toBe(1);
    const none = await request(app)
      .get(`${BASE}/${ids[1] ?? ''}/recording`)
      .set(auth(owner));
    expect(none.status).toBe(404);
    const imp = await tokenFor(owner.user, {
      sid: 'imp_rec',
      imp: new Types.ObjectId().toString(),
    });
    expect(
      (
        await request(app)
          .get(`${BASE}/${ids[0] ?? ''}/recording`)
          .set(auth({ token: imp }))
      ).body.error.code,
    ).toBe('AUTH_IMPERSONATION_BLOCKED');
  });
});

describe('OpenAPI', () => {
  it('documents every calls route', () => {
    const paths = Object.keys(buildOpenApiDocument().paths ?? {});
    expect(paths).toEqual(
      expect.arrayContaining([
        '/api/v1/calls/web',
        '/api/v1/calls',
        '/api/v1/calls/active',
        '/api/v1/calls/{id}',
        '/api/v1/calls/{id}/transcript',
        '/api/v1/calls/{id}/events',
        '/api/v1/calls/{id}/recording',
        '/api/v1/calls/{id}/hangup',
      ]),
    );
  });
});

describe('without a voice runtime', () => {
  it('the /calls routes are not mounted', async () => {
    const plain = buildTestApp();
    expect((await request(plain).get(BASE).set(auth(owner))).status).toBe(404);
  });
});

describe('cross-process hangup over the call bus (Phase 12)', () => {
  it('a hangup on another server is handed to the process running the call (202)', async () => {
    const url = (await requireRedis()).url;
    const subA = new Redis(url);
    const subB = new Redis(url);
    const busA = new CallControlBus({ redis, subscriber: subA, prefix, nodeId: 'node-a' });
    const busB = new CallControlBus({ redis, subscriber: subB, prefix, nodeId: 'node-b' });
    await busA.start();
    await busB.start();
    manager.attachBus(busA);
    const other = new CallManager({
      logger: silent,
      registry,
      tts: new TtsCache({ tts: new FakeTts(), storage }),
      storage,
      recordingDir,
      scriptFor: () =>
        Promise.resolve({ script: scriptOf(waitLong), voice: 'alloy', language: 'hi' }),
    });
    other.attachBus(busB);
    const appB = buildTestApp(
      {},
      {
        storage,
        aiProvider: createFakeProvider(),
        calls: { manager: other, registry, textInput: true, voiceProvider: 'fake' },
      },
    );
    try {
      const caller = await t.addUser('admin');
      const started = await web(caller, { flowId, contactId });
      expect(started.status, JSON.stringify(started.body)).toBe(201);
      const { call, mediaTicket, wsPath } = started.body.data;
      const port = (server.address() as AddressInfo).port;
      const ws = await connect(
        `ws://127.0.0.1:${String(port)}${wsPath as string}?ticket=${mediaTicket as string}`,
      );
      await vi.waitFor(
        async () => expect((await CallModel.findById(call.id).lean())?.status).toBe('in_progress'),
        { timeout: 10_000 },
      );
      expect(await busB.nodeOfCall(call.id as string)).toBe('node-a');
      const hung = await request(appB)
        .post(`${BASE}/${call.id as string}/hangup`)
        .set(auth(caller));
      expect(hung.status, JSON.stringify(hung.body)).toBe(202);
      await vi.waitFor(
        async () =>
          expect((await CallModel.findById(call.id).lean())?.endReason).toBe('customer_hangup'),
        { timeout: 10_000 },
      );
      await vi.waitFor(async () => expect(await busB.nodeOfCall(call.id as string)).toBeNull());
      const audit = await AuditLogModel.findOne({
        action: 'call.hung_up_remotely',
        'target.id': call.id,
      }).lean<{ meta: Record<string, unknown> }>();
      expect(audit?.meta).toMatchObject({ forwarded: true });
      // nobody holds it any more → 409 from either server
      const again = await request(appB)
        .post(`${BASE}/${call.id as string}/hangup`)
        .set(auth(caller));
      expect([again.status, again.body.error.code]).toEqual([409, 'CALL_NOT_ACTIVE']);
      ws.close();
    } finally {
      await busA.stop();
      await busB.stop();
      subA.disconnect();
      subB.disconnect();
    }
  });
});
