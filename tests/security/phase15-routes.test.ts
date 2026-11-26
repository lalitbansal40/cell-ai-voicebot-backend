import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { CampaignModel } from '../../src/db/models/campaign.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { ExportJobModel } from '../../src/db/models/export-job.model';
import { MessageModel } from '../../src/db/models/message.model';
import { WebhookDeliveryModel } from '../../src/db/models/webhook-delivery.model';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import { WhatsAppCampaignModel } from '../../src/db/models/whatsapp-campaign.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppScheduledCallModel } from '../../src/db/models/whatsapp-scheduled-call.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import { API_KEY_SCOPES, type ApiKeyScope } from '../../src/modules/api-keys/scopes';
import { sha256Hex } from '../../src/modules/auth/hmac';
import type { CallManager } from '../../src/modules/calls/call.service';
import type { CallRegistry } from '../../src/modules/calls/registry';
import { buildPublicSpec, type OpenApiDoc } from '../../src/modules/docs/public-spec';
import type { CallingRuntime } from '../../src/modules/whatsapp-calling/runtime';
import { createScheduledCalls } from '../../src/modules/whatsapp-calling/scheduled.service';
import { buildOpenApiDocument } from '../../src/openapi';
import { createLogger } from '../../src/shared/logger';
import { callDoc } from '../helpers/analytics';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp, testEnv } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
// the calls router needs a voice runtime; access is decided before any of it is used
const calls = {
  manager: {} as CallManager,
  registry: { liveCalls: () => Promise.resolve([]) } as unknown as CallRegistry,
  textInput: false,
  voiceProvider: 'fake' as const,
};
const world = useInboxWorld();
let app: ReturnType<typeof buildTestApp>;

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Route {
  method: Method;
  path: string;
}

/** Every route the public docs list = every route an API key can reach. */
const ROUTES: Route[] = Object.entries(
  buildPublicSpec(buildOpenApiDocument() as unknown as OpenApiDoc).paths,
).flatMap(([path, item]) =>
  Object.keys(item).map((method) => ({ method: method as Method, path })),
);

/** TPL: reads that both template scopes may run. */
const TEMPLATE_READS = new Set([
  'GET /api/v1/whatsapp/templates',
  'GET /api/v1/whatsapp/templates/{id}',
]);

/** Bodies valid enough to pass validation, so the answer is about access only. */
const BODIES: Record<string, object> = {
  // TPL
  'patch /api/v1/whatsapp/templates/{id}': {
    components: [{ type: 'BODY', text: 'Hi {{1}}, a test.', example: { body_text: [['A']] } }],
  },
  'patch /api/v1/whatsapp/templates/{id}/variables': { sources: [{ key: '1', kind: 'ask' }] },
  // SAC-T8
  'patch /api/v1/whatsapp/scheduled-calls/{id}': { purpose: 'Reminder' },
  'patch /api/v1/contacts/{id}': { name: 'Changed' },
  'patch /api/v1/webhook-endpoints/{id}': { description: 'Changed' },
  'post /api/v1/webhook-endpoints/{id}/test': { type: 'call.completed' },
  'patch /api/v1/whatsapp-campaigns/{id}': {
    name: 'Changed',
    channelId: '6720f0a1b2c3d4e5f6a7b8d1',
    variants: [{ key: 'A', templateId: '6720f0a1b2c3d4e5f6a7b8d2', splitPct: 100 }],
    audience: { contactIds: ['6720f0a1b2c3d4e5f6a7b8d3'] },
  },
};

const makeKey = async (account: TestAccount, scopes: ApiKeyScope[]) => {
  const key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId: account.account._id,
    name: `k-${scopes.join('-')}`.slice(0, 58),
    prefix: key.slice(0, PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes,
    createdBy: new Types.ObjectId(),
  });
  return key;
};

/** Query strings valid enough to pass validation (the answer is about access only). */
const QUERIES: Record<string, () => string> = {
  'get /api/v1/whatsapp/channels/{id}/calling/quote': () => `?contactId=${ids.contact}`,
};

const send = (key: string, route: Route, id: (path: string) => string) => {
  const url =
    route.path.replace('{id}', id(route.path)) +
    (QUERIES[`${route.method} ${route.path}`]?.() ?? '');
  const req = request(app)
    [route.method](url)
    .set('X-API-Key', key)
    .set('Idempotency-Key', new Types.ObjectId().toString());
  const body = BODIES[`${route.method} ${route.path}`];
  return route.method === 'get' || route.method === 'delete' ? req : req.send(body ?? {});
};

let a: TestAccount;
let b: TestAccount;
const ids = {} as Record<
  | 'call'
  | 'contact'
  | 'campaign'
  | 'message'
  | 'exportJob'
  | 'endpoint'
  | 'delivery'
  | 'channel'
  | 'waCampaign'
  | 'scheduledCall'
  | 'template',
  string
>;

/** Account A's record for a path (the first `{id}` decides the kind). */
const idFor = (path: string): string => {
  if (path.startsWith('/api/v1/calls/')) return ids.call;
  if (path.startsWith('/api/v1/contacts/')) return ids.contact;
  if (path.startsWith('/api/v1/campaigns/')) return ids.campaign;
  if (path.startsWith('/api/v1/messages/')) return ids.message;
  if (path.startsWith('/api/v1/exports/')) return ids.exportJob;
  if (path.startsWith('/api/v1/webhook-endpoints/')) return ids.endpoint;
  if (path.startsWith('/api/v1/webhook-deliveries/')) return ids.delivery;
  if (path.startsWith('/api/v1/whatsapp/channels/')) return ids.channel;
  if (path.startsWith('/api/v1/whatsapp-campaigns/')) return ids.waCampaign;
  if (path.startsWith('/api/v1/whatsapp/scheduled-calls/')) return ids.scheduledCall;
  // TPL: templates by API key
  if (path.startsWith('/api/v1/whatsapp/templates/')) return ids.template;
  throw new Error(`no record kind for ${path}`);
};

beforeAll(async () => {
  app = buildTestApp(
    {},
    {
      // the matrix sends hundreds of requests from one IP: the flood guard must not answer
      rateLimit: { limit: 100_000 },
      storage,
      contactJobs: recordingContactJobs().jobs,
      calls,
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
        // access is decided before the calling runtime is touched
        calling: {
          env: testEnv(),
          // SAC-T8: scheduled calls are read from the database (no call media here)
          scheduled: createScheduledCalls({
            logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
            calls: null,
            permissions: null,
          }),
        } as unknown as CallingRuntime,
      },
    },
  );
  a = await createTestAccount();
  b = await createTestAccount();
  const accountId = a.account._id;
  const contact = await ContactModel.create({
    accountId,
    phoneE164: '+919876500001',
    name: 'Iso Contact',
    searchText: 'iso contact',
    source: { type: 'manual', importJobId: null },
  });
  ids.contact = contact._id.toString();
  const call = callDoc(accountId, {
    provider: 'webcall',
    variables: {},
    outcome: {},
    metrics: emptyCallMetrics(),
    cost: emptyCallCost(),
    recording: null,
    flowRunId: null,
    error: null,
    languageDetected: null,
    insights: null,
    dispositionSource: null,
  });
  await CallModel.collection.insertOne(call);
  ids.call = call._id.toString();
  // minimal raw documents: only their owner matters here
  ids.campaign = (
    await CampaignModel.collection.insertOne({ accountId, name: 'Iso', status: 'draft' })
  ).insertedId.toString();
  ids.message = (
    await MessageModel.collection.insertOne({ accountId, direction: 'out', origin: 'api' })
  ).insertedId.toString();
  ids.exportJob = (
    await ExportJobModel.collection.insertOne({ accountId, scope: 'calls', status: 'ready' })
  ).insertedId.toString();
  const endpoint = await WebhookEndpointModel.create({
    accountId,
    url: 'https://hooks.example.com/iso',
    secretSealed: 'v1:x:y:z',
  });
  ids.endpoint = endpoint._id.toString();
  ids.waCampaign = (
    await WhatsAppCampaignModel.collection.insertOne({ accountId, name: 'Iso', status: 'draft' })
  ).insertedId.toString();
  ids.channel = (
    await WhatsAppChannelModel.collection.insertOne({ accountId, status: 'connected' })
  ).insertedId.toString();
  ids.scheduledCall = (
    await WhatsAppScheduledCallModel.collection.insertOne({
      accountId,
      channelId: new Types.ObjectId(ids.channel),
      contactId: new Types.ObjectId(ids.contact),
      conversationId: null,
      program: { kind: 'agent', id: new Types.ObjectId() },
      dueAt: new Date(Date.now() + 86_400_000),
      timezone: 'Asia/Kolkata',
      status: 'scheduled',
      retry: { max: 0, gapMin: 30, on: [] },
      attempts: [],
      callIds: [],
      createdBy: new Types.ObjectId(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  ).insertedId.toString();
  ids.template = (
    await WhatsAppTemplateModel.collection.insertOne({
      accountId,
      wabaId: 'iso_waba',
      channelIds: [],
      name: 'iso_template',
      language: 'en',
      category: 'UTILITY',
      status: 'DRAFT',
      components: [],
      variables: [],
      statusHistory: [],
      editsLog: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  ).insertedId.toString();
  ids.delivery = (
    await WebhookDeliveryModel.collection.insertOne({
      accountId,
      endpointId: endpoint._id,
      eventId: 'evt_iso',
      type: 'call.completed',
      status: 'failed',
    })
  ).insertedId.toString();
});

describe('Phase 15 public API routes (security)', () => {
  it('covers every key-enabled route', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(48);
  });

  it("another account's key (every scope) gets 404 for each of this account's records", async () => {
    const key = await makeKey(b, [...API_KEY_SCOPES]);
    const leaks: string[] = [];
    for (const route of ROUTES.filter((r) => r.path.includes('{id}'))) {
      const res = await send(key, route, idFor);
      if (res.status !== 404) leaks.push(`${route.method} ${route.path} → ${String(res.status)}`);
    }
    expect(leaks).toEqual([]);
    // nothing of A changed
    expect((await ContactModel.findById(ids.contact).lean())?.name).toBe('Iso Contact');
    expect(await WebhookEndpointModel.exists({ _id: ids.endpoint })).toBeTruthy();
  });

  it("the owner's key reaches its own records (the 404s above are about the account)", async () => {
    const key = await makeKey(a, [...API_KEY_SCOPES]);
    for (const path of [
      '/api/v1/contacts/{id}',
      '/api/v1/calls/{id}',
      '/api/v1/webhook-endpoints/{id}',
    ]) {
      const res = await send(key, { method: 'get', path }, idFor);
      expect(res.status, path).toBe(200);
    }
  });

  it('scope × route matrix (each route opens to exactly its scope)', async () => {
    const matrix: Record<string, ApiKeyScope[]> = {};
    for (const scope of API_KEY_SCOPES) {
      const key = await makeKey(a, [scope]);
      for (const route of ROUTES) {
        const res = await send(key, route, () => new Types.ObjectId().toString());
        expect(res.body.error?.message, `${route.method} ${route.path}`).not.toBe(
          'Route not found',
        );
        const denied = res.status === 403 && res.body.error?.code === 'AUTH_FORBIDDEN';
        if (!denied) (matrix[`${route.method.toUpperCase()} ${route.path}`] ??= []).push(scope);
      }
    }
    for (const route of ROUTES) {
      const name = `${route.method.toUpperCase()} ${route.path}`;
      if (route.path === '/api/v1/api-keys/whoami') continue; // any valid key
      // TPL: template reads open to a read key and to a key that manages templates
      if (TEMPLATE_READS.has(name)) {
        expect(matrix[name]?.sort(), name).toEqual(['templates:read', 'templates:write']);
        continue;
      }
      expect(matrix[name], name).toHaveLength(1);
    }
    expect(Object.fromEntries(Object.entries(matrix).sort())).toMatchSnapshot();
  });
});
