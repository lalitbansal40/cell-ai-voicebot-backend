import { writeFileSync } from 'node:fs';
import path from 'node:path';

import Ajv from 'ajv/dist/2020';
import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { CallModel, emptyCallCost, emptyCallMetrics } from '../../src/db/models/call.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import { API_KEY_SCOPES } from '../../src/modules/api-keys/scopes';
import { sha256Hex } from '../../src/modules/auth/hmac';
import type { CallManager } from '../../src/modules/calls/call.service';
import type { CallRegistry } from '../../src/modules/calls/registry';
import { buildPublicSpec, type OpenApiDoc } from '../../src/modules/docs/public-spec';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplate } from '../../src/modules/templates/template.service';
import type { CallingRuntime } from '../../src/modules/whatsapp-calling/runtime';
import { buildOpenApiDocument } from '../../src/openapi';
import { callDoc } from '../helpers/analytics';
import { ensureRateCard, fund } from '../helpers/calls';
import { recordingContactJobs, useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { auth, createAgentDoc, FLOWS } from '../helpers/flows';
import { useInboxWorld } from '../helpers/inbox';
import { buildTestApp } from '../helpers/test-app';
import { userActor } from '../helpers/whatsapp';

/**
 * DOCS-T7 (`npm run docs:smoke`, not part of `npm test`): every documented request example
 * against the real app with fake providers. A route passes when its answer is one of its
 * documented statuses (never 5xx) and a 2xx body matches the documented schema.
 */

useTestDb();
const storage = useTempStorage();
const world = useInboxWorld();
const { state } = world;
const spec = buildPublicSpec(buildOpenApiDocument() as unknown as OpenApiDoc);
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });

type Method = 'get' | 'post' | 'patch' | 'delete';
interface Op {
  operationId: string;
  requestBody?: {
    content?: Record<string, { example?: unknown; examples?: Record<string, { value: unknown }> }>;
  };
  responses: Record<string, { content?: Record<string, { schema?: unknown }> }>;
  parameters?: { name: string; in: string; required?: boolean }[];
}

const ids: Record<string, string> = {};
let app: ReturnType<typeof buildTestApp>;
let key: string;

/** Real ids for a path's `{id}` (the first segment decides the kind). */
const idFor = (p: string): string => {
  const kinds: [string, string][] = [
    ['/api/v1/contacts/', 'contact'],
    ['/api/v1/calls/', 'call'],
    ['/api/v1/campaigns/', 'campaign'],
    ['/api/v1/whatsapp-campaigns/', 'waCampaign'],
    ['/api/v1/messages/', 'message'],
    ['/api/v1/exports/', 'export'],
    ['/api/v1/webhook-endpoints/', 'endpoint'],
    ['/api/v1/webhook-deliveries/', 'delivery'],
    ['/api/v1/whatsapp/channels/', 'channel'],
  ];
  const kind = kinds.find(([prefix]) => p.startsWith(prefix))?.[1];
  return (kind && ids[kind]) ?? new Types.ObjectId().toString();
};

/** Request bodies with this world's ids (other bodies are sent as documented). */
const bodyFor = (method: string, p: string, example: unknown): unknown => {
  const k = `${method.toUpperCase()} ${p}`;
  const unique = String(Date.now()).slice(-5);
  const overrides: Record<string, unknown> = {
    'POST /api/v1/contacts': { phone: `+9190055${unique}`, name: 'Ravi Kumar' },
    'POST /api/v1/calls': { contactId: ids.contact, agentId: ids.agent },
    'POST /api/v1/messages/template': {
      contactId: ids.contact,
      channelId: ids.channel,
      template: { name: ids.templateName, language: 'en' },
      variables: { '1': 'Asha' },
    },
    'POST /api/v1/messages/text': { contactId: ids.contact, text: 'Hello' },
    'POST /api/v1/campaigns': {
      name: `Smoke ${unique}`,
      mode: 'dry_run',
      line: 'phone',
      flowId: ids.flow,
      audience: { contactIds: [ids.contact] },
    },
    'POST /api/v1/whatsapp-campaigns': {
      name: `Smoke ${unique}`,
      channelId: ids.channel,
      variants: [{ key: 'A', templateId: ids.template, splitPct: 100 }],
      variables: { '1': { kind: 'contact.name' } },
      audience: { contactIds: [ids.contact] },
    },
    'PATCH /api/v1/whatsapp-campaigns/{id}': {
      name: `Smoke edited ${unique}`,
      channelId: ids.channel,
      variants: [{ key: 'A', templateId: ids.template, splitPct: 100 }],
      variables: { '1': { kind: 'contact.name' } },
      audience: { contactIds: [ids.contact] },
    },
  };
  return overrides[k] ?? example;
};

/** Order: creates first (their ids feed later routes), destructive actions last. */
const rank = (method: string, p: string) =>
  method === 'delete'
    ? 4
    : /\/(stop|cancel|rotate-secret)$/.test(p)
      ? 3
      : method === 'post' && !p.includes('{')
        ? 0
        : 1;

const rows: string[] = [];

beforeAll(async () => {
  const { users } = await world.setup();
  const calls = {
    manager: {
      startOutboundCall: async (input: { accountId: string; contactId: string }) => {
        const doc = callDoc(new Types.ObjectId(input.accountId), {
          provider: 'dryrun',
          contactId: new Types.ObjectId(input.contactId),
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
        await CallModel.collection.insertOne(doc);
        return { callId: doc._id.toString(), ended: new Promise(() => undefined) };
      },
    } as unknown as CallManager,
    registry: { liveCalls: () => Promise.resolve([]) } as unknown as CallRegistry,
    textInput: false,
    voiceProvider: 'fake' as const,
  };
  app = buildTestApp(
    {},
    {
      storage,
      contactJobs: recordingContactJobs().jobs,
      calls,
      whatsapp: {
        ctx: world.w.ctx,
        jobs: { enqueueEvent: () => Promise.resolve() },
        inboxJobs: world.jobs,
        storage: world.storage,
        calling: {} as CallingRuntime,
      },
    },
  );
  const accountId = state.acc.account._id;
  await ensureRateCard();
  await fund(accountId, 5_000_000_000);
  await WhatsAppChannelModel.updateOne(
    { _id: state.channel._id },
    { $set: { messagingLimitTier: 'TIER_10K', qualityRating: 'GREEN' } },
  );
  ids.channel = state.channel._id.toString();
  ids.templateName = 'emi_reminder';
  const t = await createTemplate(
    { wa: world.w.ctx, jobs: recordingTemplateJobs(), storage: world.storage },
    accountId,
    userActor(users.owner.user._id),
    {
      channelId: ids.channel,
      name: ids.templateName,
      language: 'en',
      category: 'UTILITY',
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your EMI is due.', example: { body_text: [['A']] } },
      ],
    },
  );
  await WhatsAppTemplateModel.updateOne({ _id: t.id }, { $set: { status: 'APPROVED' } });
  ids.template = t.id;
  ids.contact = (
    await ContactModel.create({
      accountId,
      phoneE164: '+919000000001',
      name: 'Asha Verma',
      source: { type: 'manual' },
    })
  )._id.toString();
  ids.agent = await createAgentDoc(accountId, 'Smoke agent');
  const flow = await request(app)
    .post(FLOWS)
    .set(auth(users.owner))
    .send({ name: 'Smoke flow', templateKey: 'payment_reminder', agentIds: { ai: ids.agent } });
  ids.flow = flow.body.data?.id as string;
  if (ids.flow) {
    await request(app)
      .post(`${FLOWS}/${ids.flow}/publish`)
      .set(auth(users.owner))
      .send({ revision: 1 });
  }
  key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId,
    name: 'smoke',
    prefix: key.slice(0, PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes: [...API_KEY_SCOPES],
    createdBy: users.owner.user._id,
  });
});

describe('every documented example (DOCS-T7)', () => {
  it('answers a documented status and, on success, the documented shape', async () => {
    const ops = Object.entries(spec.paths)
      .flatMap(([p, item]) =>
        Object.entries(item).map(([method, op]) => ({ method: method as Method, p, op: op as Op })),
      )
      .sort((a, b) => rank(a.method, a.p) - rank(b.method, b.p));
    const failures: string[] = [];
    for (const { method, p, op } of ops) {
      const media = op.requestBody?.content?.['application/json'];
      const example = media?.example ?? Object.values(media?.examples ?? {})[0]?.value;
      const query = (op.parameters ?? [])
        .filter((q) => q.in === 'query' && q.required)
        .map((q) => `${q.name}=${q.name === 'contactId' ? ids.contact : '2026-11-01'}`)
        .join('&');
      const url = p.replace('{id}', idFor(p)) + (query ? `?${query}` : '');
      let req = request(app)
        [method](url)
        .set('X-API-Key', key)
        .set('Idempotency-Key', new Types.ObjectId().toString());
      if (media) req = req.send(bodyFor(method, p, example) as object);
      const res = await req;
      const status = String(res.status);
      const documented = Object.keys(op.responses);
      let note = '';
      if (!documented.includes(status) || res.status === 500) {
        note = `undocumented ${status}: ${JSON.stringify(res.body?.error ?? res.text).slice(0, 160)}`;
      } else if (res.status < 300) {
        const schema = op.responses[status]?.content?.['application/json']?.schema;
        if (schema) {
          // `#/components/...` refs resolve against this root
          const valid = ajv.validate({ ...schema, components: spec.components }, res.body);
          if (!valid) note = `schema: ${ajv.errorsText(ajv.errors).slice(0, 200)}`;
        }
        // remember created ids for later routes
        const id = (res.body?.data as { id?: string } | undefined)?.id;
        const kind = idFor(p) && !p.includes('{') && method === 'post' ? p : '';
        if (id && kind) {
          const map: Record<string, string> = {
            '/api/v1/campaigns': 'campaign',
            '/api/v1/whatsapp-campaigns': 'waCampaign',
            '/api/v1/webhook-endpoints': 'endpoint',
            '/api/v1/exports/calls': 'export',
            '/api/v1/calls': 'call',
            '/api/v1/messages/template': 'message',
          };
          if (map[p]) ids[map[p]] = id;
        }
      }
      rows.push(`| ${method.toUpperCase()} | \`${p}\` | ${status} | ${note ? `✗ ${note}` : '✓'} |`);
      if (note) failures.push(`${method.toUpperCase()} ${p}: ${note}`);
    }
    writeFileSync(
      path.resolve(__dirname, '..', '..', 'docs', 'api', '_smoke.md'),
      [
        '# Public API examples smoke',
        '',
        'Generated by `npm run docs:smoke` — every documented example against a local app with fake providers.',
        '',
        `Operations: ${String(rows.length)} · failures: ${String(failures.length)}`,
        '',
        '| Method | Path | Status | Result |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
      ].join('\n'),
    );
    expect(failures).toEqual([]);
  }, 300_000);
});
