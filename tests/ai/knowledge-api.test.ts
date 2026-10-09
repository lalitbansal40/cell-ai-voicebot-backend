import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AI_LIMITS } from '../../src/config/limits';
import { createFakeProvider } from '../../src/core/ai';
import { credit } from '../../src/core/billing/engine';
import { AiAgentModel } from '../../src/db/models/ai-agent.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { KnowledgeBaseModel } from '../../src/db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../../src/db/models/knowledge-chunk.model';
import { KnowledgeSourceModel } from '../../src/db/models/knowledge-source.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import { ingestSource } from '../../src/modules/knowledge/ingest.job';
import { recordingAiJobs } from '../helpers/ai';
import { createTestAccount, tokenFor, type TestAccount, type TestUser } from '../helpers/auth';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const storage = useTempStorage();
const rec = recordingAiJobs();
const app = buildTestApp({}, { storage, aiJobs: rec.jobs });
const auth = (u: { token: string }) => ({ Authorization: `Bearer ${u.token}` });
const URL = '/api/v1/knowledge-bases';
const FIXTURES = path.resolve(__dirname, '../fixtures/knowledge');
const file = (name: string) => readFileSync(path.join(FIXTURES, name));

let t: TestAccount;
let manager: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  t = await createTestAccount();
  manager = await t.addUser('manager');
  viewer = await t.addUser('viewer');
  await credit({
    accountId: t.account._id,
    type: 'adjustment',
    amountMicros: 100_000_000,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${t.account._id.toString()}`,
  });
});

const createKb = async (name: string, user = manager) => {
  const res = await request(app).post(URL).set(auth(user)).send({ name, description: 'Docs' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string };
};
const upload = (kbId: string, files: [string, Buffer, string?][], user = manager) => {
  let req = request(app).post(`${URL}/${kbId}/sources/files`).set(auth(user));
  for (const [name, data, type] of files)
    req = req.attach('files', data, { filename: name, contentType: type ?? 'text/plain' });
  return req;
};
const ingestAll = async () => {
  for (const job of rec.queued.splice(0)) {
    if (job.name === 'kb.ingest') {
      await ingestSource(job.data as never, {
        provider: createFakeProvider(),
        storage,
        jobs: rec.jobs,
        throttleMs: 0,
      });
    }
  }
};

describe('knowledge bases', () => {
  it('creates, lists, renames; names are unique case-insensitively', async () => {
    const kb = await createKb('Loan FAQ');
    const list = await request(app).get(URL).set(auth(viewer));
    expect(list.body.data[0]).toMatchObject({
      id: kb.id,
      name: 'Loan FAQ',
      description: 'Docs',
      sourcesCount: 0,
      chunksCount: 0,
      status: 'ok',
      linkedAgents: [],
    });
    const dup = await request(app).post(URL).set(auth(manager)).send({ name: 'loan faq' });
    expect(dup.status).toBe(409);
    const other = await createKb('Other');
    expect(
      (await request(app).patch(`${URL}/${other.id}`).set(auth(manager)).send({ name: 'LOAN FAQ' }))
        .status,
    ).toBe(409);
    const renamed = await request(app)
      .patch(`${URL}/${other.id}`)
      .set(auth(manager))
      .send({ name: 'Policies' });
    expect(renamed.body.data.name).toBe('Policies');
    expect(
      await AuditLogModel.findOne({ action: 'kb.updated', 'target.id': other.id }).lean(),
    ).toMatchObject({
      meta: { fields: ['name'] },
    });
    expect(
      await AuditLogModel.countDocuments({ action: 'kb.created', accountId: t.account._id }),
    ).toBe(2);
  });

  it('caps knowledge bases per account', async () => {
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    await KnowledgeBaseModel.insertMany(
      Array.from({ length: AI_LIMITS.kbPerAccount }, (_, i) => ({
        accountId: other.account._id,
        name: `KB ${i}`,
      })),
    );
    const res = await request(app).post(URL).set(auth(o)).send({ name: 'One more' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KNOWLEDGE_LIMIT_REACHED');
  });
});

describe('sources', () => {
  let kbId: string;
  beforeAll(async () => {
    kbId = (await createKb('Sources KB')).id;
  });

  it('uploads files (stored privately, queued, audited) and ingests them', async () => {
    rec.queued.length = 0;
    const res = await upload(kbId, [
      ['faq.txt', file('faq.txt')],
      ['guide.pdf', file('guide.pdf'), 'application/pdf'],
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(
      res.body.data.map((s: { title: string; status: string; fileType: string }) => [
        s.title,
        s.status,
        s.fileType,
      ]),
    ).toEqual([
      ['faq.txt', 'queued', 'txt'],
      ['guide.pdf', 'queued', 'pdf'],
    ]);
    expect(res.body.data[0]).not.toHaveProperty('fileKey');
    expect(rec.queued.map((j) => j.name)).toEqual(['kb.ingest', 'kb.ingest']);
    const stored = await KnowledgeSourceModel.findById(res.body.data[0].id).lean();
    expect(stored?.fileKey).toBe(
      `accounts/${t.account._id.toString()}/knowledge/${res.body.data[0].id}.txt`,
    );
    expect(await storage.exists(stored?.fileKey ?? '')).toBe(true);
    const audit = await AuditLogModel.find({
      action: 'kb.source_changed',
      'target.id': kbId,
    }).lean();
    expect(audit.map((a) => a.meta)).toEqual([
      { change: 'added', kind: 'file', title: 'faq.txt' },
      { change: 'added', kind: 'file', title: 'guide.pdf' },
    ]);

    await ingestAll();
    const sources = await request(app).get(`${URL}/${kbId}/sources`).set(auth(viewer));
    expect(sources.body.data.every((s: { status: string }) => s.status === 'ready')).toBe(true);
    const kb = await request(app).get(`${URL}/${kbId}`).set(auth(viewer));
    expect(kb.body.data).toMatchObject({
      sourcesCount: 2,
      embeddingModel: 'text-embedding-3-small',
    });
    expect(kb.body.data.chunksCount).toBeGreaterThan(3);
  });

  it('search returns the right chunk with its source title (viewers allowed)', async () => {
    const res = await request(app)
      .post(`${URL}/${kbId}/search`)
      .set(auth(viewer))
      .send({ query: 'late fee kitni hai', topK: 2 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ title: 'Late fee', sourceTitle: 'faq.txt' });
    expect(res.body.data[0].score).toBeGreaterThan(res.body.data[1].score);
    const strict = await request(app)
      .post(`${URL}/${kbId}/search`)
      .set(auth(viewer))
      .send({ query: 'late fee kitni hai', minScoreHundredths: 100 });
    expect(strict.body.data).toEqual([]);
    expect(
      (await request(app).post(`${URL}/${kbId}/search`).set(auth(viewer)).send({ query: '' }))
        .status,
    ).toBe(422);
  });

  it.each([
    ['fake.pdf', Buffer.from('just text'), 'application/pdf'],
    ['words.docx', Buffer.from('PK\u0003\u0004 nothing'), 'application/zip'],
    ['binary.txt', Buffer.from([0x61, 0, 0x62]), 'text/plain'],
    ['image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png'],
    ['faq.txt', Buffer.from('hello'), 'image/png'],
  ])('rejects %s with 415', async (name, data, type) => {
    const res = await upload(kbId, [[name, data, type]]);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects big files (413), too many files and none (422)', async () => {
    const big = await upload(kbId, [['big.txt', Buffer.alloc(AI_LIMITS.fileMaxBytes + 1, 0x61)]]);
    expect(big.status).toBe(413);
    const six = await upload(
      kbId,
      Array.from({ length: 6 }, (_, i): [string, Buffer] => [`f${i}.txt`, Buffer.from('x')]),
    );
    expect(six.status).toBe(422);
    expect((await upload(kbId, [])).status).toBe(422);
  });

  it('adds a URL source; blocked / invalid addresses are refused at add time', async () => {
    rec.queued.length = 0;
    const ok = await request(app)
      .post(`${URL}/${kbId}/sources/url`)
      .set(auth(manager))
      .send({ url: 'https://help.example.com/faq' });
    expect(ok.status).toBe(202);
    expect(ok.body.data).toMatchObject({
      kind: 'url',
      title: 'help.example.com/faq',
      status: 'queued',
      url: 'https://help.example.com/faq',
    });
    expect(rec.queued).toHaveLength(1);
    for (const url of [
      'http://169.254.169.254/latest',
      'ftp://help.example.com/x',
      'https://help.example.com:22/x',
    ]) {
      const res = await request(app)
        .post(`${URL}/${kbId}/sources/url`)
        .set(auth(manager))
        .send({ url });
      expect(res.status, url).toBe(422);
      expect(res.body.error.code).toBe('FUNCTION_URL_BLOCKED');
    }
    const bad = await request(app)
      .post(`${URL}/${kbId}/sources/url`)
      .set(auth(manager))
      .send({ url: 'not a url' });
    expect(bad.body.error.details[0].path).toBe('url');
  });

  it('reindexes one source or all (version bump, queued)', async () => {
    const sources = await KnowledgeSourceModel.find({ kbId }).lean();
    const one = sources[0];
    rec.queued.length = 0;
    const res = await request(app)
      .post(`${URL}/${kbId}/sources/${one?._id.toString()}/reindex`)
      .set(auth(manager));
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe('queued');
    expect((await KnowledgeSourceModel.findById(one?._id).lean())?.version).toBe(
      (one?.version ?? 0) + 1,
    );
    const all = await request(app).post(`${URL}/${kbId}/reindex`).set(auth(manager));
    expect(all.status).toBe(202);
    expect(all.body.data).toHaveLength(sources.length);
    expect(rec.queued).toHaveLength(1 + sources.length);
    await ingestAll();
  });

  it('deletes a source with its chunks and file', async () => {
    const source = await KnowledgeSourceModel.findOne({ kbId, title: 'faq.txt' }).lean();
    const id = source?._id.toString() ?? '';
    expect(await KnowledgeChunkModel.countDocuments({ sourceId: source?._id })).toBeGreaterThan(0);
    const res = await request(app).delete(`${URL}/${kbId}/sources/${id}`).set(auth(manager));
    expect(res.status).toBe(204);
    expect(await KnowledgeChunkModel.countDocuments({ sourceId: source?._id })).toBe(0);
    expect(await storage.exists(source?.fileKey ?? '')).toBe(false);
    expect(
      (await request(app).delete(`${URL}/${kbId}/sources/${id}`).set(auth(manager))).status,
    ).toBe(404);
    const kb = await KnowledgeBaseModel.findById(kbId).lean();
    expect(kb?.sourcesCount).toBe(2);
    expect(
      await AuditLogModel.findOne({ action: 'kb.source_changed', 'meta.change': 'removed' }).lean(),
    ).toMatchObject({
      meta: { change: 'removed', kind: 'file', title: 'faq.txt' },
    });
  });

  it('caps sources per knowledge base', async () => {
    const full = await createKb('Full KB');
    await KnowledgeSourceModel.insertMany(
      Array.from({ length: AI_LIMITS.sourcesPerKb }, (_, i) => ({
        accountId: t.account._id,
        kbId: new Types.ObjectId(full.id),
        kind: 'url',
        title: `s${i}`,
        url: 'https://x.example',
      })),
    );
    const res = await upload(full.id, [['faq.txt', file('faq.txt')]]);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('KNOWLEDGE_LIMIT_REACHED');
  });

  it('rate-limits source adds per account (20 / h)', async () => {
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    const kb = await createKb('Limited', o);
    for (let i = 0; i < AI_LIMITS.kbSourcesPerHour; i += 1) {
      const res = await request(app)
        .post(`${URL}/${kb.id}/sources/url`)
        .set(auth(o))
        .send({ url: `https://x.example/${i}` });
      expect(res.status).toBe(i < AI_LIMITS.sourcesPerKb ? 202 : 422);
    }
    const limited = await request(app)
      .post(`${URL}/${kb.id}/sources/url`)
      .set(auth(o))
      .send({ url: 'https://x.example/last' });
    expect(limited.status).toBe(429);
  });
});

describe('delete, permissions and isolation', () => {
  it('refuses to delete a linked base unless forced (then unlinks and cleans up)', async () => {
    const kb = await createKb('Linked KB');
    const agent = await request(app)
      .post('/api/v1/agents')
      .set(auth(manager))
      .send({ name: 'KB user' });
    await request(app)
      .patch(`/api/v1/agents/${agent.body.data.id}`)
      .set(auth(manager))
      .send({ knowledge: { knowledgeBaseIds: [kb.id] } });
    rec.queued.length = 0;
    await upload(kb.id, [['faq.txt', file('faq.txt')]]);
    await ingestAll();
    const source = await KnowledgeSourceModel.findOne({ kbId: kb.id }).lean();

    const listed = await request(app).get(`${URL}/${kb.id}`).set(auth(viewer));
    expect(listed.body.data.linkedAgents).toEqual([{ id: agent.body.data.id, name: 'KB user' }]);
    const refused = await request(app).delete(`${URL}/${kb.id}`).set(auth(manager));
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('KB user');

    const forced = await request(app).delete(`${URL}/${kb.id}?force=true`).set(auth(manager));
    expect(forced.status).toBe(204);
    expect(
      (await AiAgentModel.findById(agent.body.data.id).lean())?.knowledge.knowledgeBaseIds,
    ).toEqual([]);
    expect(await KnowledgeSourceModel.countDocuments({ kbId: kb.id })).toBe(0);
    expect(await KnowledgeChunkModel.countDocuments({ kbId: kb.id })).toBe(0);
    expect(await storage.exists(source?.fileKey ?? '')).toBe(false);
    expect(
      await AuditLogModel.findOne({ action: 'kb.deleted', 'target.id': kb.id }).lean(),
    ).toMatchObject({
      meta: { name: 'Linked KB', sources: 1, unlinkedAgents: 1 },
    });
  });

  it('viewers and impersonators cannot write', async () => {
    const kb = await createKb('Perm KB');
    expect((await request(app).post(URL).set(auth(viewer)).send({ name: 'x' })).status).toBe(403);
    expect((await upload(kb.id, [['faq.txt', file('faq.txt')]], viewer)).status).toBe(403);
    expect((await request(app).delete(`${URL}/${kb.id}`).set(auth(viewer))).status).toBe(403);
    const owner = await t.addUser('owner');
    const imp = { token: await tokenFor(owner.user, { imp: 'a'.repeat(24) }) };
    const res = await request(app)
      .post(`${URL}/${kb.id}/sources/url`)
      .set(auth(imp))
      .send({ url: 'https://x.example' });
    expect(res.body.error.code).toBe('AUTH_IMPERSONATION_BLOCKED');
    expect((await request(app).get(`${URL}/${kb.id}`).set(auth(imp))).status).toBe(200);
    const suspended = await createTestAccount({ status: 'suspended' });
    const so = await suspended.addUser('owner');
    expect((await request(app).post(URL).set(auth(so)).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).get(URL)).status).toBe(401);
  });

  it("another account's base is 404 everywhere", async () => {
    const kb = await createKb('Private KB');
    const source = await KnowledgeSourceModel.create({
      accountId: t.account._id,
      kbId: kb.id,
      kind: 'url',
      title: 'p',
      url: 'https://x.example',
    });
    const other = await createTestAccount();
    const o = await other.addUser('owner');
    const sid = source._id.toString();
    const calls = [
      request(app).get(`${URL}/${kb.id}`).set(auth(o)),
      request(app).patch(`${URL}/${kb.id}`).set(auth(o)).send({ name: 'x' }),
      request(app).delete(`${URL}/${kb.id}`).set(auth(o)),
      request(app).get(`${URL}/${kb.id}/sources`).set(auth(o)),
      upload(kb.id, [['faq.txt', file('faq.txt')]], o),
      request(app)
        .post(`${URL}/${kb.id}/sources/url`)
        .set(auth(o))
        .send({ url: 'https://x.example' }),
      request(app).delete(`${URL}/${kb.id}/sources/${sid}`).set(auth(o)),
      request(app).post(`${URL}/${kb.id}/sources/${sid}/reindex`).set(auth(o)),
      request(app).post(`${URL}/${kb.id}/reindex`).set(auth(o)),
      request(app).post(`${URL}/${kb.id}/search`).set(auth(o)).send({ query: 'x' }),
    ];
    for (const [i, res] of (await Promise.all(calls)).entries())
      expect(res.status, `call ${i}`).toBe(404);
    expect((await request(app).get(URL).set(auth(o))).body.data).toEqual([]);
    const ownKb = await createKb('Own KB', o);
    expect(
      (await request(app).delete(`${URL}/${ownKb.id}/sources/${sid}`).set(auth(o))).status,
    ).toBe(404);
  });
});
