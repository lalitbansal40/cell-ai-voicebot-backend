import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import type { Env } from '../../config/env';
import { AI_LIMITS } from '../../config/limits';
import { outgoingPolicy, urlBlockReason } from '../../core/ai/ip-guard';
import type { AiJobs } from '../../core/ai/jobs';
import { detectKnowledgeFile, KNOWLEDGE_CONTENT_TYPES, stripControl } from '../../core/ai/parsers';
import { knowledgeIndex, searchKnowledgeBases } from '../../core/ai/retrieve';
import type { AiProvider } from '../../core/ai/types';
import { notifyAccount } from '../../core/realtime/notify';
import { storageKey, type StorageProvider } from '../../core/storage';
import { isDuplicateKeyError } from '../../db/errors';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { KnowledgeBaseModel, type KnowledgeBaseDoc } from '../../db/models/knowledge-base.model';
import { KnowledgeChunkModel } from '../../db/models/knowledge-chunk.model';
import {
  KnowledgeSourceModel,
  type KnowledgeSourceDoc,
} from '../../db/models/knowledge-source.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import { AppError, ConflictError, NotFoundError } from '../../shared/errors/app-error';
import { auditRequest } from '../audit/audit.service';

import type { AddUrlBody, CreateKbBody, SearchKbBody, UpdateKbBody } from './knowledge.schema';

export const KB_NAME_COLLATION = { locale: 'en', strength: 2 } as const;

export interface KnowledgeDeps {
  env: Pick<
    Env,
    'NODE_ENV' | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS' | 'APP_URL' | 'OPENAI_EMBEDDING_MODEL'
  >;
  provider: Pick<AiProvider, 'embed'>;
  jobs: AiJobs;
  storage?: StorageProvider;
  /** Tests only: extra ports allowed for URL sources. */
  extraPorts?: number[];
}

export interface UploadedKnowledgeFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const iso = (d: Date) => d.toISOString();

export const toSourceView = (s: KnowledgeSourceDoc) => ({
  id: s._id.toString(),
  kbId: s.kbId.toString(),
  kind: s.kind,
  title: s.title,
  fileType: s.fileType ?? null,
  url: s.url ?? null,
  bytes: s.bytes,
  chars: s.chars,
  chunks: s.chunks,
  status: s.status,
  progress: s.progress,
  error: s.error ?? null,
  createdAt: iso(s.createdAt),
  updatedAt: iso(s.updatedAt),
});

const linkedAgents = async (accountId: Types.ObjectId, kbIds: Types.ObjectId[]) => {
  const agents = await AiAgentModel.find({
    accountId,
    'knowledge.knowledgeBaseIds': { $in: kbIds },
  })
    .select({ name: 1, 'knowledge.knowledgeBaseIds': 1 })
    .sort({ name: 1 })
    .lean<
      { _id: Types.ObjectId; name: string; knowledge: { knowledgeBaseIds: Types.ObjectId[] } }[]
    >();
  return (kbId: Types.ObjectId) =>
    agents
      .filter((a) => a.knowledge.knowledgeBaseIds.some((id) => id.equals(kbId)))
      .map((a) => ({ id: a._id.toString(), name: a.name }));
};

const toKbView = (
  kb: KnowledgeBaseDoc,
  agents: { id: string; name: string }[],
  currentModel: string,
) => ({
  id: kb._id.toString(),
  name: kb.name,
  description: kb.description ?? null,
  sourcesCount: kb.sourcesCount,
  chunksCount: kb.chunksCount,
  // a model change makes stored vectors unusable until re-indexed
  status:
    kb.status === 'stale' || (kb.embeddingModel && kb.embeddingModel !== currentModel)
      ? ('stale' as const)
      : ('ok' as const),
  embeddingModel: kb.embeddingModel ?? null,
  linkedAgents: agents,
  createdAt: iso(kb.createdAt),
  updatedAt: iso(kb.updatedAt),
});

export const findKb = async (accountId: Types.ObjectId, id: string): Promise<KnowledgeBaseDoc> => {
  const _id = toObjectId(id);
  const kb = _id
    ? await KnowledgeBaseModel.findOne({ _id, accountId }).lean<KnowledgeBaseDoc>()
    : null;
  if (!kb) throw new NotFoundError('Knowledge base not found');
  return kb;
};

const findSource = async (kb: KnowledgeBaseDoc, sid: string): Promise<KnowledgeSourceDoc> => {
  const _id = toObjectId(sid);
  const source = _id
    ? await KnowledgeSourceModel.findOne({
        _id,
        kbId: kb._id,
        accountId: kb.accountId,
      }).lean<KnowledgeSourceDoc>()
    : null;
  if (!source) throw new NotFoundError('Source not found');
  return source;
};

const duplicate = () =>
  new ConflictError('CONFLICT_DUPLICATE', 'A knowledge base with this name already exists.', [
    { path: 'name', message: 'Already exists' },
  ]);

const limit = (message: string) => new AppError('KNOWLEDGE_LIMIT_REACHED', message);

/** Live progress for one source (`kb.source.updated`). */
export const notifySource = (
  s: Pick<KnowledgeSourceDoc, 'accountId' | 'kbId' | '_id' | 'status' | 'progress' | 'error'>,
) =>
  notifyAccount(s.accountId.toString(), 'kb.source.updated', {
    kbId: s.kbId.toString(),
    sourceId: s._id.toString(),
    status: s.status,
    progress: s.progress,
    ...(s.error ? { error: s.error } : {}),
  });

/** Recomputes a base's counts and bumps its version (vector caches reload). */
export const refreshKbCounts = async (kbId: Types.ObjectId): Promise<void> => {
  const [stats] = await KnowledgeSourceModel.aggregate<{ sources: number; chunks: number }>([
    { $match: { kbId } },
    { $group: { _id: null, sources: { $sum: 1 }, chunks: { $sum: '$chunks' } } },
  ]);
  await KnowledgeBaseModel.updateOne(
    { _id: kbId },
    {
      $set: { sourcesCount: stats?.sources ?? 0, chunksCount: stats?.chunks ?? 0 },
      $inc: { version: 1 },
    },
  );
  knowledgeIndex().invalidate(kbId.toString());
};

export const listKbs = async (req: Request, deps: Pick<KnowledgeDeps, 'env'>) => {
  const { accountId } = tenantFilter(req);
  const kbs = await KnowledgeBaseModel.find({ accountId })
    .sort({ name: 1 })
    .lean<KnowledgeBaseDoc[]>();
  const agentsOf = await linkedAgents(
    accountId,
    kbs.map((k) => k._id),
  );
  return kbs.map((kb) => toKbView(kb, agentsOf(kb._id), deps.env.OPENAI_EMBEDDING_MODEL));
};

export const getKb = async (req: Request, id: string, deps: Pick<KnowledgeDeps, 'env'>) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  return toKbView(
    kb,
    (await linkedAgents(accountId, [kb._id]))(kb._id),
    deps.env.OPENAI_EMBEDDING_MODEL,
  );
};

export const createKb = async (
  req: Request,
  body: z.infer<typeof CreateKbBody>,
  deps: Pick<KnowledgeDeps, 'env'>,
) => {
  const { accountId } = tenantFilter(req);
  if ((await KnowledgeBaseModel.countDocuments({ accountId })) >= AI_LIMITS.kbPerAccount) {
    throw limit(`An account can have at most ${AI_LIMITS.kbPerAccount} knowledge bases.`);
  }
  const taken = await KnowledgeBaseModel.findOne({ accountId, name: body.name })
    .collation(KB_NAME_COLLATION)
    .select({ _id: 1 })
    .lean();
  if (taken) throw duplicate();
  try {
    const doc = await KnowledgeBaseModel.create({
      accountId,
      name: body.name,
      description: body.description ?? null,
      createdBy: new Types.ObjectId(requireAuth(req).userId),
    });
    const kb = doc.toObject({ transform: false });
    await auditRequest(req, 'kb.created', {
      target: { type: 'knowledge_base', id: kb._id.toString() },
      meta: { name: kb.name },
    });
    return toKbView(kb, [], deps.env.OPENAI_EMBEDDING_MODEL);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicate();
    throw err;
  }
};

export const updateKb = async (
  req: Request,
  id: string,
  body: z.infer<typeof UpdateKbBody>,
  deps: Pick<KnowledgeDeps, 'env'>,
) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  if (body.name) {
    const taken = await KnowledgeBaseModel.findOne({
      accountId,
      name: body.name,
      _id: { $ne: kb._id },
    })
      .collation(KB_NAME_COLLATION)
      .select({ _id: 1 })
      .lean();
    if (taken) throw duplicate();
  }
  try {
    await KnowledgeBaseModel.updateOne({ _id: kb._id, accountId }, { $set: body });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicate();
    throw err;
  }
  await auditRequest(req, 'kb.updated', {
    target: { type: 'knowledge_base', id: kb._id.toString() },
    meta: { fields: Object.keys(body).sort() },
  });
  return getKb(req, id, deps);
};

/** Removes a source's chunks and file (best effort for the file). */
const purgeSource = async (source: KnowledgeSourceDoc, storage?: StorageProvider) => {
  await KnowledgeChunkModel.deleteMany({ sourceId: source._id, accountId: source.accountId });
  if (source.fileKey && storage) await storage.delete(source.fileKey).catch(() => undefined);
  await KnowledgeSourceModel.deleteOne({ _id: source._id, accountId: source.accountId });
};

export const deleteKb = async (
  req: Request,
  id: string,
  force: boolean,
  deps: Pick<KnowledgeDeps, 'storage'>,
): Promise<void> => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  const agents = (await linkedAgents(accountId, [kb._id]))(kb._id);
  if (agents.length && !force) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `Used by ${agents.map((a) => a.name).join(', ')}. Remove it from these agents first.`,
      agents.map((a) => ({ path: 'agents', message: a.name })),
    );
  }
  if (agents.length) {
    await AiAgentModel.updateMany(
      { accountId, 'knowledge.knowledgeBaseIds': kb._id },
      { $pull: { 'knowledge.knowledgeBaseIds': kb._id } },
    );
    for (const a of agents) notifyAccount(accountId.toString(), 'agent.updated', { agentId: a.id });
  }
  const sources = await KnowledgeSourceModel.find({ kbId: kb._id, accountId }).lean<
    KnowledgeSourceDoc[]
  >();
  for (const s of sources) await purgeSource(s, deps.storage);
  await KnowledgeChunkModel.deleteMany({ kbId: kb._id, accountId });
  await KnowledgeBaseModel.deleteOne({ _id: kb._id, accountId });
  knowledgeIndex().invalidate(kb._id.toString());
  await auditRequest(req, 'kb.deleted', {
    target: { type: 'knowledge_base', id: kb._id.toString() },
    meta: { name: kb.name, sources: sources.length, unlinkedAgents: agents.length },
  });
};

export const listSources = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  const sources = await KnowledgeSourceModel.find({ kbId: kb._id, accountId })
    .sort({ createdAt: -1, _id: -1 })
    .lean<KnowledgeSourceDoc[]>();
  return sources.map(toSourceView);
};

const assertRoom = async (kb: KnowledgeBaseDoc, adding: number) => {
  const count = await KnowledgeSourceModel.countDocuments({
    kbId: kb._id,
    accountId: kb.accountId,
  });
  if (count + adding > AI_LIMITS.sourcesPerKb) {
    throw limit(`A knowledge base can have at most ${AI_LIMITS.sourcesPerKb} sources.`);
  }
};

const sourceChanged = (
  req: Request,
  kb: KnowledgeBaseDoc,
  change: 'added' | 'removed' | 'reindexed',
  source: Pick<KnowledgeSourceDoc, 'kind' | 'title'>,
) =>
  auditRequest(req, 'kb.source_changed', {
    target: { type: 'knowledge_base', id: kb._id.toString() },
    meta: { change, kind: source.kind, title: source.title },
  });

const enqueueIngest = async (source: KnowledgeSourceDoc, jobs: AiJobs) => {
  await jobs.enqueue('kb.ingest', {
    accountId: source.accountId.toString(),
    kbId: source.kbId.toString(),
    sourceId: source._id.toString(),
    version: source.version,
  });
  notifySource(source);
};

const fileTitle = (name: string) =>
  stripControl(name.split(/[\\/]/).pop() ?? name)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled';

export const addFiles = async (
  req: Request,
  id: string,
  files: UploadedKnowledgeFile[],
  deps: KnowledgeDeps,
) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  if (!files.length)
    throw new AppError('VALIDATION_FAILED', undefined, [
      { path: 'files', message: 'Choose at least one file' },
    ]);
  const typed = files.map((f) => ({
    file: f,
    type: detectKnowledgeFile(f.originalname, f.mimetype, f.buffer),
  }));
  const bad = typed.find((t) => !t.type);
  if (bad) {
    throw new AppError(
      'UNSUPPORTED_MEDIA_TYPE',
      `"${fileTitle(bad.file.originalname)}" is not a real PDF, DOCX, TXT or MD file.`,
    );
  }
  await assertRoom(kb, files.length);
  if (!deps.storage) throw new Error('File storage is not configured');
  const userId = new Types.ObjectId(requireAuth(req).userId);
  const created: KnowledgeSourceDoc[] = [];
  for (const { file, type } of typed) {
    const _id = new Types.ObjectId();
    const fileType = type ?? 'txt';
    const key = storageKey({
      accountId: accountId.toString(),
      area: 'knowledge',
      id: _id.toString(),
      ext: fileType,
    });
    await deps.storage.put(key, file.buffer, { contentType: KNOWLEDGE_CONTENT_TYPES[fileType] });
    const doc = await KnowledgeSourceModel.create({
      _id,
      accountId,
      kbId: kb._id,
      kind: 'file',
      title: fileTitle(file.originalname),
      fileType,
      fileKey: key,
      bytes: file.size,
      status: 'queued',
      version: 1,
      createdBy: userId,
    });
    const source = doc.toObject({ transform: false });
    created.push(source);
    await sourceChanged(req, kb, 'added', source);
    await enqueueIngest(source, deps.jobs);
  }
  await refreshKbCounts(kb._id);
  return created.map(toSourceView);
};

export const addUrl = async (
  req: Request,
  id: string,
  body: z.infer<typeof AddUrlBody>,
  deps: KnowledgeDeps,
) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  let url: URL;
  try {
    url = new URL(body.url);
  } catch {
    throw new AppError('VALIDATION_FAILED', undefined, [
      { path: 'url', message: 'Enter a full web address' },
    ]);
  }
  const policy = outgoingPolicy(deps.env, deps.extraPorts);
  if (urlBlockReason(url, policy)) {
    throw new AppError('FUNCTION_URL_BLOCKED', undefined, [
      {
        path: 'url',
        message:
          policy.httpsOnly && url.protocol !== 'https:'
            ? 'Only https addresses are allowed'
            : 'This address is not allowed',
      },
    ]);
  }
  await assertRoom(kb, 1);
  const doc = await KnowledgeSourceModel.create({
    accountId,
    kbId: kb._id,
    kind: 'url',
    title: (body.title ?? `${url.hostname}${url.pathname === '/' ? '' : url.pathname}`).slice(
      0,
      200,
    ),
    url: url.toString(),
    status: 'queued',
    version: 1,
    createdBy: new Types.ObjectId(requireAuth(req).userId),
  });
  const source = doc.toObject({ transform: false });
  await sourceChanged(req, kb, 'added', source);
  await enqueueIngest(source, deps.jobs);
  await refreshKbCounts(kb._id);
  return toSourceView(source);
};

export const deleteSource = async (
  req: Request,
  id: string,
  sid: string,
  deps: Pick<KnowledgeDeps, 'storage'>,
): Promise<void> => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  const source = await findSource(kb, sid);
  await purgeSource(source, deps.storage);
  await refreshKbCounts(kb._id);
  await sourceChanged(req, kb, 'removed', source);
};

/** Bumps the version (old chunks stop being read) and queues the ingest. */
const requeue = async (source: KnowledgeSourceDoc, jobs: AiJobs): Promise<KnowledgeSourceDoc> => {
  const next = await KnowledgeSourceModel.findOneAndUpdate(
    { _id: source._id, accountId: source.accountId },
    { $inc: { version: 1 }, $set: { status: 'queued', progress: 0, error: null } },
    { returnDocument: 'after' },
  ).lean<KnowledgeSourceDoc>();
  if (!next) throw new NotFoundError('Source not found');
  await enqueueIngest(next, jobs);
  return next;
};

/** Re-queues sources of a base (all, or the given ones) — shared with the `kb.reindex` job. */
export const requeueSources = async (
  kbId: Types.ObjectId,
  accountId: Types.ObjectId,
  jobs: AiJobs,
  sourceIds?: Types.ObjectId[],
): Promise<KnowledgeSourceDoc[]> => {
  const sources = await KnowledgeSourceModel.find({
    kbId,
    accountId,
    ...(sourceIds ? { _id: { $in: sourceIds } } : {}),
  }).lean<KnowledgeSourceDoc[]>();
  const out: KnowledgeSourceDoc[] = [];
  for (const s of sources) out.push(await requeue(s, jobs));
  await refreshKbCounts(kbId);
  return out;
};

export const reindexSource = async (req: Request, id: string, sid: string, deps: KnowledgeDeps) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  const source = await findSource(kb, sid);
  const [next] = await requeueSources(kb._id, accountId, deps.jobs, [source._id]);
  await sourceChanged(req, kb, 'reindexed', source);
  return toSourceView(next ?? source);
};

export const reindexKb = async (req: Request, id: string, deps: KnowledgeDeps) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  const sources = await requeueSources(kb._id, accountId, deps.jobs);
  await KnowledgeBaseModel.updateOne({ _id: kb._id, accountId }, { $set: { status: 'ok' } });
  await auditRequest(req, 'kb.source_changed', {
    target: { type: 'knowledge_base', id: kb._id.toString() },
    meta: { change: 'reindexed', kind: 'all', title: kb.name, sources: sources.length },
  });
  return sources.map(toSourceView);
};

export const searchKb = async (
  req: Request,
  id: string,
  body: z.infer<typeof SearchKbBody>,
  deps: KnowledgeDeps,
) => {
  const { accountId } = tenantFilter(req);
  const kb = await findKb(accountId, id);
  const { hits } = await searchKnowledgeBases(
    accountId,
    [kb._id],
    body.query,
    { topK: body.topK, minScore: body.minScoreHundredths / 100 },
    { provider: deps.provider, model: deps.env.OPENAI_EMBEDDING_MODEL },
  );
  const titles = new Map(
    (
      await KnowledgeSourceModel.find({
        accountId,
        _id: { $in: hits.map((h) => new Types.ObjectId(h.sourceId)) },
      })
        .select({ title: 1 })
        .lean<{ _id: Types.ObjectId; title: string }[]>()
    ).map((s) => [s._id.toString(), s.title]),
  );
  return hits.map((h) => ({
    chunkId: h.chunkId,
    sourceId: h.sourceId,
    sourceTitle: titles.get(h.sourceId) ?? '',
    title: h.title,
    text: h.text,
    score: h.score,
  }));
};
