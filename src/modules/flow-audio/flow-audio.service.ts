import type { Request } from 'express';
import { Types } from 'mongoose';

import { FLOW_LIMITS } from '../../config/limits';
import { probeAudio } from '../../core/engine/audio-probe';
import { storageKey, type StorageProvider } from '../../core/storage';
import { decodedCacheKey } from '../../core/voice/audio/decode';
import { isDuplicateKeyError } from '../../db/errors';
import { FlowAudioModel, type FlowAudioDoc } from '../../db/models/flow-audio.model';
import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error';
import { escapeRegex } from '../../shared/utils/regex';
import { auditRequest } from '../audit/audit.service';
import { flowsUsingAudio } from '../flows/in-use';

export interface FlowAudioDeps {
  storage?: StorageProvider;
}

const NAME_COLLATION = { locale: 'en', strength: 2 } as const;
const CONTENT_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg' } as const;
const DAY_MS = 24 * 60 * 60 * 1000;

const needStorage = (deps: FlowAudioDeps): StorageProvider => {
  if (!deps.storage) throw new AppError('INTERNAL_ERROR', 'File storage is not configured.');
  return deps.storage;
};

const toView = (a: FlowAudioDoc, users: Map<string, string>) => ({
  id: a._id.toString(),
  name: a.name,
  format: a.format,
  bytes: a.bytes,
  durationMs: a.durationMs,
  sampleRate: a.sampleRate,
  channels: a.channels,
  uploadedBy: a.uploadedBy
    ? { id: a.uploadedBy.toString(), name: users.get(a.uploadedBy.toString()) ?? '' }
    : null,
  createdAt: a.createdAt.toISOString(),
});

const userNames = async (ids: (Types.ObjectId | null)[]) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const users = unique.length
    ? await UserModel.find({ _id: { $in: unique } })
        .select({ name: 1 })
        .lean<{ _id: Types.ObjectId; name: string }[]>()
    : [];
  return new Map(users.map((u) => [u._id.toString(), u.name]));
};

const findAudio = async (accountId: Types.ObjectId, id: string): Promise<FlowAudioDoc> => {
  const _id = toObjectId(id);
  const audio = _id ? await FlowAudioModel.findOne({ _id, accountId }).lean<FlowAudioDoc>() : null;
  if (!audio) throw new NotFoundError('Audio not found');
  return audio;
};

const nameTaken = async (accountId: Types.ObjectId, name: string, exceptId?: Types.ObjectId) =>
  Boolean(
    await FlowAudioModel.findOne({
      accountId,
      name,
      ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    })
      .collation(NAME_COLLATION)
      .select({ _id: 1 })
      .lean(),
  );

const duplicateName = () =>
  new ConflictError('CONFLICT_DUPLICATE', 'An audio file with this name already exists.', [
    { path: 'name', message: 'Already exists' },
  ]);

export const listAudio = async (req: Request, q?: string) => {
  const { accountId } = tenantFilter(req);
  const filter: Record<string, unknown> = { accountId };
  if (q) filter.name = { $regex: escapeRegex(q), $options: 'i' };
  const items = await FlowAudioModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(FLOW_LIMITS.audiosPerAccount)
    .lean<FlowAudioDoc[]>();
  const users = await userNames(items.map((a) => a.uploadedBy));
  return items.map((a) => toView(a, users));
};

export interface UploadedAudio {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export const uploadAudio = async (
  req: Request,
  file: UploadedAudio | undefined,
  name: string | undefined,
  deps: FlowAudioDeps,
) => {
  const { accountId } = tenantFilter(req);
  if (!file) throw new ValidationError([{ path: 'file', message: 'Choose a WAV or MP3 file' }]);
  if ((await FlowAudioModel.countDocuments({ accountId })) >= FLOW_LIMITS.audiosPerAccount) {
    throw new ValidationError([
      {
        path: 'file',
        message: `Audio limit reached (${String(FLOW_LIMITS.audiosPerAccount)} files)`,
      },
    ]);
  }
  const probe = /\.(wav|mp3)$/i.test(file.originalname) ? probeAudio(file.buffer) : null;
  if (!probe) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Upload a WAV (PCM, A-law or μ-law) or MP3 file.');
  }
  if (probe.durationMs > FLOW_LIMITS.audioMaxMs) {
    throw new ValidationError([
      { path: 'file', message: `Longer than ${String(FLOW_LIMITS.audioMaxMs / 1000)} seconds` },
    ]);
  }
  const base =
    (name ?? file.originalname.replace(/\.[^.]*$/, '')).trim().slice(0, FLOW_LIMITS.nameMaxChars) ||
    'Audio';
  let finalName = base;
  if (name !== undefined) {
    if (await nameTaken(accountId, finalName)) throw duplicateName();
  } else {
    for (let n = 2; await nameTaken(accountId, finalName); n += 1) {
      const end = ` (${String(n)})`;
      finalName = `${base.slice(0, FLOW_LIMITS.nameMaxChars - end.length)}${end}`;
    }
  }
  const storage = needStorage(deps);
  const _id = new Types.ObjectId();
  const key = storageKey({
    accountId: accountId.toString(),
    area: 'flow-audio',
    id: _id.toString(),
    ext: probe.format,
  });
  await storage.put(key, file.buffer, { contentType: CONTENT_TYPES[probe.format] });
  const userId = new Types.ObjectId(requireAuth(req).userId);
  let doc: FlowAudioDoc;
  try {
    doc = (
      await FlowAudioModel.create({
        _id,
        accountId,
        name: finalName,
        fileKey: key,
        format: probe.format,
        bytes: file.size,
        durationMs: probe.durationMs,
        sampleRate: probe.sampleRate,
        channels: probe.channels,
        uploadedBy: userId,
      })
    ).toObject({ transform: false });
  } catch (err) {
    await storage.delete(key);
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
  await auditRequest(req, 'flow_audio.changed', {
    target: { type: 'flow_audio', id: _id.toString() },
    meta: { change: 'uploaded', name: finalName, durationMs: probe.durationMs },
  });
  return toView(doc, await userNames([userId]));
};

export const audioUrl = async (req: Request, id: string, deps: FlowAudioDeps) => {
  const audio = await findAudio(tenantFilter(req).accountId, id);
  const url = await needStorage(deps).signedUrl(audio.fileKey, {
    expiresInSec: FLOW_LIMITS.audioUrlTtlSec,
  });
  return { url, expiresAt: new Date(Date.now() + FLOW_LIMITS.audioUrlTtlSec * 1000).toISOString() };
};

export const renameAudio = async (req: Request, id: string, name: string) => {
  const { accountId } = tenantFilter(req);
  const audio = await findAudio(accountId, id);
  if (await nameTaken(accountId, name, audio._id)) throw duplicateName();
  let updated: FlowAudioDoc | null;
  try {
    updated = await FlowAudioModel.findOneAndUpdate(
      { _id: audio._id, accountId },
      { $set: { name } },
      { returnDocument: 'after' },
    ).lean<FlowAudioDoc>();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw duplicateName();
    throw err;
  }
  if (!updated) throw new NotFoundError('Audio not found');
  await auditRequest(req, 'flow_audio.changed', {
    target: { type: 'flow_audio', id },
    meta: { change: 'renamed', name, durationMs: audio.durationMs },
  });
  return toView(updated, await userNames([updated.uploadedBy]));
};

export const deleteAudio = async (req: Request, id: string) => {
  const { accountId } = tenantFilter(req);
  const audio = await findAudio(accountId, id);
  const flows = await flowsUsingAudio(audio._id);
  if (flows.length) {
    throw new ConflictError(
      'RESOURCE_IN_USE',
      `This audio is used by ${String(flows.length)} call flow${flows.length === 1 ? '' : 's'}.`,
      flows.map((f) => ({ path: 'flows', message: f.name, id: f.id })),
    );
  }
  await FlowAudioModel.updateOne(
    { _id: audio._id, accountId },
    { $set: { deletedAt: new Date() } },
  );
  await auditRequest(req, 'flow_audio.changed', {
    target: { type: 'flow_audio', id },
    meta: { change: 'deleted', name: audio.name, durationMs: audio.durationMs },
  });
};

/** Deletes files + rows of audio soft-deleted more than 30 days ago. */
export const purgeDeletedAudio = async (
  storage: StorageProvider,
  now = new Date(),
): Promise<{ audio: number }> => {
  const cutoff = new Date(now.getTime() - FLOW_LIMITS.deletedFlowPurgeDays * DAY_MS);
  const old = await FlowAudioModel.find({ deletedAt: { $ne: null, $lte: cutoff } })
    .setOptions({ withDeleted: true })
    .select({ fileKey: 1, accountId: 1 })
    .lean<Pick<FlowAudioDoc, '_id' | 'fileKey' | 'accountId'>[]>();
  let audio = 0;
  for (const a of old) {
    await storage.delete(a.fileKey);
    // decoded copy used by live calls (Phase 7), if any
    await storage.delete(
      decodedCacheKey({ id: a._id.toString(), accountId: a.accountId.toString() }),
    );
    const res = await FlowAudioModel.deleteOne({ _id: a._id }).setOptions({ withDeleted: true });
    audio += res.deletedCount;
  }
  return { audio };
};
