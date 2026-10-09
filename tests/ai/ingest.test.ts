import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

import { Types } from 'mongoose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeProvider } from '../../src/core/ai';
import { searchKnowledgeBases } from '../../src/core/ai/retrieve';
import type { AiProvider } from '../../src/core/ai/types';
import { credit } from '../../src/core/billing/engine';
import * as notify from '../../src/core/realtime/notify';
import { storageKey } from '../../src/core/storage';
import { KnowledgeBaseModel } from '../../src/db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../../src/db/models/knowledge-chunk.model';
import {
  KnowledgeSourceModel,
  type KnowledgeFileType,
} from '../../src/db/models/knowledge-source.model';
import { LedgerEntryModel } from '../../src/db/models/ledger-entry.model';
import { DEFAULT_RATE_CARD, RateCardModel } from '../../src/db/models/rate-card.model';
import {
  ingestSource,
  INGEST_MESSAGES,
  reindexKnowledgeBase,
  type IngestContext,
} from '../../src/modules/knowledge/ingest.job';
import { AppError } from '../../src/shared/errors/app-error';
import { recordingAiJobs } from '../helpers/ai';
import { useTempStorage } from '../helpers/contacts';
import { useTestDb } from '../helpers/db';
import { json, useStubServer } from '../helpers/stub-server';

useTestDb();
const storage = useTempStorage();
const stub = useStubServer();
const rec = recordingAiJobs();
const FIXTURES = path.resolve(__dirname, '../fixtures/knowledge');
const R = 1_000_000;

let accountId: Types.ObjectId;
let kbId: Types.ObjectId;

const fund = (id: Types.ObjectId, micros = 100 * R) =>
  credit({
    accountId: id,
    type: 'adjustment',
    amountMicros: micros,
    ref: { type: 'manual', id: 'x' },
    idempotencyKey: `fund-${id.toString()}-${micros}`,
  });

beforeAll(async () => {
  await RateCardModel.create({ accountId: null, ...DEFAULT_RATE_CARD, effectiveFrom: new Date(0) });
  accountId = new Types.ObjectId();
  await fund(accountId);
  kbId = (await KnowledgeBaseModel.create({ accountId, name: 'Main' }))._id;
});
beforeEach(() => stub.reset());
afterEach(() => vi.restoreAllMocks());

const ctx = (provider: Pick<AiProvider, 'embed'> = createFakeProvider()) => ({
  provider,
  storage,
  jobs: rec.jobs,
  throttleMs: 0,
  http: {
    extraPorts: [stub.port],
    resolve: () => Promise.resolve(['1.2.3.4']),
    dial: () => '127.0.0.1',
  },
});

const addFile = async (file: string, type: KnowledgeFileType, kb = kbId, account = accountId) => {
  const _id = new Types.ObjectId();
  const key = storageKey({
    accountId: account.toString(),
    area: 'knowledge',
    id: _id.toString(),
    ext: type,
  });
  await storage.put(key, readFileSync(path.join(FIXTURES, file)), {
    contentType: 'application/octet-stream',
  });
  return KnowledgeSourceModel.create({
    _id,
    accountId: account,
    kbId: kb,
    kind: 'file',
    title: file,
    fileType: type,
    fileKey: key,
    version: 1,
  });
};
const run = (
  s: { _id: Types.ObjectId; kbId: Types.ObjectId; accountId: Types.ObjectId; version: number },
  c: IngestContext = ctx(),
) =>
  ingestSource(
    {
      accountId: s.accountId.toString(),
      kbId: s.kbId.toString(),
      sourceId: s._id.toString(),
      version: s.version,
    },
    c,
  );

describe('kb.ingest', () => {
  it('parses, chunks, embeds, charges once and marks ready (with progress events)', async () => {
    const spy = vi.spyOn(notify, 'notifyAccount');
    const source = await addFile('faq.txt', 'txt');
    expect(await run(source)).toEqual({ status: 'ready', chunks: 3 });

    const saved = await KnowledgeSourceModel.findById(source._id).lean();
    expect(saved).toMatchObject({
      status: 'ready',
      progress: 100,
      chunks: 3,
      error: null,
      embeddingModel: 'text-embedding-3-small',
    });
    expect(saved?.chars).toBeGreaterThan(300);
    const chunks = await KnowledgeChunkModel.find({ sourceId: source._id })
      .sort({ order: 1 })
      .lean();
    expect(chunks.map((c) => c.title)).toEqual(['Payment methods', 'Late fee', 'Contact hours']);
    expect(chunks.every((c) => c.dims === 1536 && c.sourceVersion === 1)).toBe(true);

    const kb = await KnowledgeBaseModel.findById(kbId).lean();
    expect(kb).toMatchObject({
      sourcesCount: 1,
      chunksCount: 3,
      embeddingModel: 'text-embedding-3-small',
    });

    const ledger = await LedgerEntryModel.find({ accountId, type: 'ai_charge' }).lean();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.ref).toEqual({ type: 'usage', id: source._id.toString() });
    expect(ledger[0]?.breakdown).toMatchObject({
      kind: 'kb_ingest',
      model: 'text-embedding-3-small',
    });
    expect(ledger[0]?.breakdown?.embeddingTokens).toBeGreaterThan(0);

    const events = spy.mock.calls
      .filter((c) => c[1] === 'kb.source.updated')
      .map((c) => c[2] as { status: string; progress: number });
    expect(events[0]).toMatchObject({ status: 'processing', progress: 5 });
    expect(events.at(-1)).toMatchObject({ status: 'ready', progress: 100 });
    expect(events.map((e) => e.progress)).toEqual(
      [...events.map((e) => e.progress)].sort((a, b) => a - b),
    );

    // the same job again (retry) charges nothing more and keeps 3 chunks
    await run(source);
    expect(await LedgerEntryModel.countDocuments({ accountId, type: 'ai_charge' })).toBe(1);
    expect(await KnowledgeChunkModel.countDocuments({ sourceId: source._id })).toBe(3);

    const { hits } = await searchKnowledgeBases(
      accountId,
      [kbId],
      'late fee kitni lagti hai',
      { topK: 1, minScore: 0 },
      { provider: createFakeProvider(), model: 'text-embedding-3-small' },
    );
    expect(hits[0]?.title).toBe('Late fee');
  });

  it.each([
    ['terms.docx', 'docx', 'Loan terms'],
    ['guide.pdf', 'pdf', 'guide.pdf'], // PDFs have no heading structure
    ['policy.md', 'md', 'Repayment policy'],
    ['hindi.txt', 'txt', 'भुगतान के तरीके'],
    ['windows1252.txt', 'txt', 'windows1252.txt'],
  ] as const)('ingests %s', async (file, type, title) => {
    const source = await addFile(file, type);
    expect((await run(source)).status).toBe('ready');
    const first = await KnowledgeChunkModel.findOne({ sourceId: source._id, order: 0 }).lean();
    expect(first?.title).toBe(title);
    if (file === 'windows1252.txt')
      expect(first?.text).toContain('Café policy: “No refunds after 30 days”');
    if (file === 'hindi.txt') expect(first?.text).toContain('आप अपनी EMI UPI');
  });

  it('a scanned PDF fails with a reason and keeps no chunks', async () => {
    const source = await addFile('scanned.pdf', 'pdf');
    expect(await run(source)).toEqual({ status: 'failed' });
    const saved = await KnowledgeSourceModel.findById(source._id).lean();
    expect(saved).toMatchObject({
      status: 'failed',
      error: 'No text found (scanned PDF?)',
      chunks: 0,
    });
  });

  it('a missing file fails', async () => {
    const source = await addFile('faq.txt', 'txt');
    await storage.delete(source.fileKey ?? '');
    await run(source);
    expect((await KnowledgeSourceModel.findById(source._id).lean())?.error).toBe(
      INGEST_MESSAGES.missingFile,
    );
  });

  it('stores prompt-injection text as plain data', async () => {
    const source = await addFile('injection.txt', 'txt');
    await run(source);
    const texts = (await KnowledgeChunkModel.find({ sourceId: source._id }).lean())
      .map((c) => c.text)
      .join('\n');
    expect(texts).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS');
  });

  it('an empty wallet fails the source with no chunks and no charge', async () => {
    const poor = new Types.ObjectId();
    const kb = await KnowledgeBaseModel.create({ accountId: poor, name: 'Poor' });
    const source = await addFile('faq.txt', 'txt', kb._id, poor);
    expect(await run(source)).toEqual({ status: 'failed' });
    expect(await KnowledgeSourceModel.findById(source._id).lean()).toMatchObject({
      status: 'failed',
      error: INGEST_MESSAGES.wallet,
      chunks: 0,
    });
    expect(await KnowledgeChunkModel.countDocuments({ sourceId: source._id })).toBe(0);
    expect(await LedgerEntryModel.countDocuments({ accountId: poor, type: 'ai_charge' })).toBe(0);
  });

  it('reindex replaces chunks with the new version; stale jobs do nothing', async () => {
    const kb = await KnowledgeBaseModel.create({ accountId, name: 'Reindex' });
    const source = await addFile('policy.md', 'md', kb._id);
    await run(source);
    const before = await KnowledgeChunkModel.find({ sourceId: source._id }).lean();
    rec.queued.length = 0;
    expect(
      await reindexKnowledgeBase(
        { accountId: accountId.toString(), kbId: kb._id.toString() },
        { jobs: rec.jobs },
      ),
    ).toEqual({ queued: 1 });
    expect(rec.queued[0]).toMatchObject({
      name: 'kb.ingest',
      data: { sourceId: source._id.toString(), version: 2 },
    });
    // the old job (version 1) is now stale
    expect(await run(source)).toEqual({ status: 'skipped' });
    const v2 = await KnowledgeSourceModel.findById(source._id).lean();
    expect(v2).toMatchObject({ status: 'queued', version: 2 });
    await run({ ...source.toObject({ transform: false }), version: 2 });
    const after = await KnowledgeChunkModel.find({ sourceId: source._id }).lean();
    expect(after).toHaveLength(before.length);
    expect(after.every((c) => c.sourceVersion === 2)).toBe(true);
    expect(after.map((c) => c._id.toString())).not.toContain(before[0]?._id.toString());
    expect(await LedgerEntryModel.countDocuments({ 'ref.id': source._id.toString() })).toBe(2);
    expect(await run({ _id: new Types.ObjectId(), kbId: kb._id, accountId, version: 1 })).toEqual({
      status: 'skipped',
    });
  });

  it('refuses to go over 2,000 chunks per knowledge base', async () => {
    const kb = await KnowledgeBaseModel.create({ accountId, name: 'Full' });
    await KnowledgeSourceModel.create({
      accountId,
      kbId: kb._id,
      kind: 'url',
      title: 'big',
      url: 'https://x.example',
      status: 'ready',
      chunks: 1999,
      version: 1,
    });
    const source = await addFile('faq.txt', 'txt', kb._id);
    await run(source);
    expect((await KnowledgeSourceModel.findById(source._id).lean())?.error).toBe(
      INGEST_MESSAGES.tooManyChunks,
    );
  });

  it('provider errors retry, then fail on the last attempt', async () => {
    const down = { embed: () => Promise.reject(new AppError('PROVIDER_UNAVAILABLE')) };
    const source = await addFile('faq.txt', 'txt');
    await expect(run(source, { ...ctx(down), attempt: { made: 0, max: 3 } })).rejects.toThrow();
    expect((await KnowledgeSourceModel.findById(source._id).lean())?.status).toBe('queued');
    expect(await run(source, { ...ctx(down), attempt: { made: 2, max: 3 } })).toEqual({
      status: 'failed',
    });
    expect((await KnowledgeSourceModel.findById(source._id).lean())?.error).toBe(
      INGEST_MESSAGES.provider,
    );
    // any other error: retried, and the last attempt ends in failed (never stuck in processing)
    await KnowledgeSourceModel.updateOne({ _id: source._id }, { $set: { status: 'queued' } });
    const boom = ctx({ embed: () => Promise.reject(new Error('boom')) });
    await expect(run(source, { ...boom, attempt: { made: 0, max: 3 } })).rejects.toThrow('boom');
    expect(await run(source, boom)).toEqual({ status: 'failed' });
    expect((await KnowledgeSourceModel.findById(source._id).lean())?.error).toBe(
      INGEST_MESSAGES.unexpected,
    );
  });
});

describe('kb.ingest — concurrency and search edges', () => {
  it('two ingests of one knowledge base run one after the other (lock)', async () => {
    const kb = await KnowledgeBaseModel.create({ accountId, name: 'Parallel' });
    const a = await addFile('faq.txt', 'txt', kb._id);
    const b = await addFile('policy.md', 'md', kb._id);
    const results = await Promise.all([run(a), run(b)]);
    expect(results.map((r) => r.status)).toEqual(['ready', 'ready']);
    const saved = await KnowledgeBaseModel.findById(kb._id).lean();
    expect(saved?.sourcesCount).toBe(2);
    expect(saved?.chunksCount).toBe(await KnowledgeChunkModel.countDocuments({ kbId: kb._id }));
  });

  it('search returns nothing for an empty query, no bases or foreign bases', async () => {
    const deps = { provider: createFakeProvider(), model: 'text-embedding-3-small' };
    const opts = { topK: 3, minScore: 0 };
    expect(await searchKnowledgeBases(accountId, [kbId], '   ', opts, deps)).toEqual({
      hits: [],
      embeddingTokens: 0,
    });
    expect(await searchKnowledgeBases(accountId, [], 'fee', opts, deps)).toEqual({
      hits: [],
      embeddingTokens: 0,
    });
    expect(await searchKnowledgeBases(new Types.ObjectId(), [kbId], 'fee', opts, deps)).toEqual({
      hits: [],
      embeddingTokens: 0,
    });
    const empty = await KnowledgeBaseModel.create({ accountId, name: 'Empty' });
    const res = await searchKnowledgeBases(accountId, [empty._id], 'fee', opts, deps);
    expect(res.hits).toEqual([]);
    expect(res.embeddingTokens).toBeGreaterThan(0);
  });
});

describe('kb.ingest — URL sources', () => {
  const urlSource = (url: string) =>
    KnowledgeSourceModel.create({ accountId, kbId, kind: 'url', title: 'page', url, version: 1 });

  it('fetches a page through the guard and strips scripts / navigation', async () => {
    stub.next((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<html><head><title>Help centre</title><script>steal()</script><style>p{}</style></head><body><nav>Home | About</nav><h1>Refunds</h1><p>Refunds take 7 working days.</p><footer>© Acme</footer></body></html>',
      );
    });
    const source = await urlSource(`http://help.public.test:${stub.port}/refunds`);
    expect((await run(source)).status).toBe('ready');
    const saved = await KnowledgeSourceModel.findById(source._id).lean();
    expect(saved?.title).toBe('Help centre');
    const text = (await KnowledgeChunkModel.find({ sourceId: source._id }).lean())
      .map((c) => c.text)
      .join('\n');
    expect(text).toContain('Refunds take 7 working days.');
    for (const gone of ['steal()', 'Home | About', '© Acme', 'p{}'])
      expect(text).not.toContain(gone);
  });

  it('accepts plain text pages and follows a redirect', async () => {
    stub.next(
      (_req, res) => res.writeHead(302, { location: '/moved' }).end(),
      (_req, res) =>
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Branch timings: 9 to 5.'),
    );
    const source = await urlSource(`http://help.public.test:${stub.port}/timings`);
    expect((await run(source)).status).toBe('ready');
    const saved = await KnowledgeSourceModel.findById(source._id).lean();
    expect(saved).toMatchObject({ title: 'page', bytes: 23 });
  });

  it.each([
    [json(200, { a: 1 }), 'Only web pages (HTML) and plain text can be added.'],
    [json(404, {}), 'The page could not be loaded (http_404).'],
    [
      (_req: unknown, res: ServerResponse) =>
        res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(2_100_000)),
      'The page is larger than 2 MB.',
    ],
  ])('fails with a clear reason (%#)', async (handler, reason) => {
    stub.next(handler);
    const source = await urlSource(`http://help.public.test:${stub.port}/x`);
    await run(source);
    expect((await KnowledgeSourceModel.findById(source._id).lean())?.error).toBe(reason);
  });

  it('a page resolving to a metadata address is blocked at fetch time (no connection made)', async () => {
    const source = await urlSource(`http://help.public.test:${stub.port}/x`);
    await run(source, {
      ...ctx(),
      http: {
        extraPorts: [stub.port],
        resolve: () => Promise.resolve(['169.254.169.254']),
        dial: () => '127.0.0.1',
      },
    });
    expect((await KnowledgeSourceModel.findById(source._id).lean())?.error).toBe(
      'This address is not allowed.',
    );
    expect(stub.requests).toHaveLength(0);
  });
});
