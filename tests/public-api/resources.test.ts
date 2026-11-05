import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { ContactListModel } from '../../src/db/models/contact-list.model';
import { ContactModel } from '../../src/db/models/contact.model';
import { FlowModel } from '../../src/db/models/flow.model';
import { WhatsAppChannelModel } from '../../src/db/models/whatsapp-channel.model';
import { generateApiKey, PREFIX_LENGTH } from '../../src/modules/api-keys/api-keys.service';
import type { ApiKeyScope } from '../../src/modules/api-keys/scopes';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { createTestAccount, type TestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
let a: TestAccount;
let b: TestAccount;

const keyFor = async (account: TestAccount, scopes: ApiKeyScope[]) => {
  const key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId: account.account._id,
    name: `k-${scopes.join('-') || 'none'}`,
    prefix: key.slice(0, PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes,
    createdBy: new Types.ObjectId(),
  });
  return key;
};

const ROUTES = [
  'flows',
  'agents',
  'whatsapp-numbers',
  'contact-lists',
  'segments',
  'phone-line',
  'ivrs',
  'wallet',
] as const;
/** Fields that must never reach an API client from these routes. */
const FORBIDDEN =
  /"(draft|graph|prompt|instructions|functions|accessToken|token\w*|secret\w*|sealed|pin\w*|metaCost\w*|wabaId)"\s*:/;

beforeAll(async () => {
  a = await createTestAccount();
  b = await createTestAccount();
  const accountId = a.account._id;
  const agent = await AiAgentModel.collection.insertOne({
    accountId,
    name: 'Recovery agent',
    language: 'hinglish',
    voice: 'coral',
    isActive: true,
    instructions: 'secret prompt',
    deletedAt: null,
    updatedAt: new Date(),
  });
  await FlowModel.collection.insertOne({
    accountId,
    name: 'Loan recovery',
    status: 'published',
    publishedVersionId: new Types.ObjectId(),
    publishedVersion: 2,
    draft: { nodes: [{ id: 'api', config: { secret: 'x' } }] },
    stats: { nodes: 3, agents: [agent.insertedId], audios: [], triggers: ['campaign'] },
    deletedAt: null,
    updatedAt: new Date(),
  });
  await WhatsAppChannelModel.collection.insertOne({
    accountId,
    label: 'Support',
    status: 'connected',
    mode: 'cloud_api',
    isOnBizApp: false,
    messageClassificationKnown: true,
    qualityRating: 'GREEN',
    messagingLimitTier: 'TIER_10K',
    displayPhoneNumber: '+91 90000 00001',
    accessTokenSealed: 'v1:secret',
    calling: { status: 'enabled' },
    createdAt: new Date(),
  });
  const list = await ContactListModel.create({
    accountId,
    name: 'November',
    source: { type: 'manual' },
  });
  await ContactModel.create({
    accountId,
    phoneE164: '+919000000001',
    name: 'Asha Verma',
    source: { type: 'manual' },
    listIds: [list._id],
  });
});

describe('account resources for API keys (DOCS-T2)', () => {
  it('a resources:read key gets minimal views — never graphs, prompts, tokens or costs', async () => {
    const key = await keyFor(a, ['resources:read']);
    for (const route of ROUTES) {
      const res = await request(app).get(`/api/v1/resources/${route}`).set('X-API-Key', key);
      expect(res.status, route).toBe(200);
      expect(JSON.stringify(res.body), route).not.toMatch(FORBIDDEN);
    }
    const flows = await request(app).get('/api/v1/resources/flows').set('X-API-Key', key);
    expect(flows.body.data).toEqual([
      expect.objectContaining({
        name: 'Loan recovery',
        publishedVersion: 2,
        triggers: ['campaign'],
        agents: [expect.objectContaining({ name: 'Recovery agent' })],
      }),
    ]);
    const numbers = await request(app)
      .get('/api/v1/resources/whatsapp-numbers')
      .set('X-API-Key', key);
    expect(numbers.body.data[0]).toMatchObject({ messagesPerSecond: 75, calling: { ready: true } });
    const lists = await request(app).get('/api/v1/resources/contact-lists').set('X-API-Key', key);
    expect(lists.body.data[0]).toMatchObject({ name: 'November', contactsCount: 1 });
    const wallet = await request(app).get('/api/v1/resources/wallet').set('X-API-Key', key);
    expect(Object.keys(wallet.body.data).sort()).toEqual([
      'availableMicros',
      'balanceMicros',
      'creditLimitMicros',
      'currency',
      'holdMicros',
    ]);
  });

  it('needs the scope, and another account sees only its own (empty) resources', async () => {
    const noScope = await keyFor(a, ['contacts:read']);
    const denied = await request(app).get('/api/v1/resources/flows').set('X-API-Key', noScope);
    expect(denied.status).toBe(403);
    expect(denied.body.error.details).toEqual([
      { path: 'scope', message: 'resources:read is required' },
    ]);
    const other = await keyFor(b, ['resources:read']);
    for (const route of ['flows', 'agents', 'whatsapp-numbers', 'contact-lists'] as const) {
      const res = await request(app).get(`/api/v1/resources/${route}`).set('X-API-Key', other);
      expect(res.body.data, route).toEqual([]);
    }
  });
});
