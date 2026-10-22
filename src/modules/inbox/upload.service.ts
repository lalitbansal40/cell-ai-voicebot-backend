import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { storageKey } from '../../core/storage';
import {
  InboxUploadModel,
  type InboxUploadDoc,
  type UploadKind,
} from '../../db/models/inbox-upload.model';
import { AppError } from '../../shared/errors/app-error';

import { inboxNow, type InboxContext } from './context';
import { mimeAgrees, sniff, type Sniffed, type SniffedKind } from './sniff';
import { VoiceFormatError } from './voice/ebml';
import { inspectOggOpus, remuxWebmOpusToOgg } from './voice/webm-to-ogg';

/** Size cap per kind (Meta's limits). */
export const UPLOAD_MAX_BYTES: Record<UploadKind, number> = {
  image: INBOX_LIMITS.imageMaxBytes,
  video: INBOX_LIMITS.videoMaxBytes,
  audio: INBOX_LIMITS.audioMaxBytes,
  voice: INBOX_LIMITS.audioMaxBytes,
  document: INBOX_LIMITS.documentMaxBytes,
  sticker: INBOX_LIMITS.stickerMaxBytes,
};

/** The largest cap — what the multipart parser accepts before the per-kind check. */
export const UPLOAD_PARSER_MAX_BYTES = Math.max(...Object.values(UPLOAD_MAX_BYTES));

const invalid = (reason: string, message: string) =>
  new AppError('WHATSAPP_MEDIA_INVALID', message, [{ path: 'file', message: reason }]);

const tooLarge = (max: number) =>
  new AppError('WHATSAPP_MEDIA_TOO_LARGE', undefined, [
    { path: 'file', message: `At most ${String(max)} bytes` },
  ]);

/** A safe display name: no path, no control characters, ≤ 200 chars, keeps its extension. */
export const sanitizeFileName = (name: string | null | undefined, ext: string): string => {
  const cleaned = basename((name ?? '').replace(/\\/g, '/'))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = `file.${ext}`;
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  if (cleaned.length <= INBOX_LIMITS.fileNameMax) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const suffix = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, INBOX_LIMITS.fileNameMax - suffix.length) + suffix;
};

/** Which sniffed kinds each upload kind accepts. */
const ACCEPTS: Record<Exclude<UploadKind, 'voice'>, SniffedKind> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
};

interface Prepared {
  bytes: Buffer;
  sniffed: Sniffed;
  voice: boolean;
  durationSec: number | null;
}

/** Voice notes: OGG / Opus mono as is, WebM / Opus remuxed, M4A (old Safari) as an audio file. */
const prepareVoice = (
  bytes: Buffer,
  sniffed: Sniffed | null,
  browserSeconds: number | null,
): Prepared => {
  try {
    if (sniffed?.mime === 'audio/webm') {
      const r = remuxWebmOpusToOgg(bytes);
      return {
        bytes: r.ogg,
        sniffed: { mime: 'audio/ogg', ext: 'ogg', kinds: ['audio'] },
        voice: true,
        durationSec: r.durationSec,
      };
    }
    if (sniffed?.mime === 'audio/ogg') {
      return { bytes, sniffed, voice: true, durationSec: inspectOggOpus(bytes).durationSec };
    }
  } catch (err) {
    if (err instanceof VoiceFormatError) throw invalid(err.reason, err.message);
    throw err;
  }
  if (sniffed?.mime === 'audio/mp4') {
    return { bytes, sniffed, voice: false, durationSec: browserSeconds };
  }
  throw invalid('not_allowed', 'Voice notes must be OGG / Opus, WebM / Opus or M4A recordings');
};

/**
 * Stores a composer upload (PHASE_10_PLAN §1d / §1f): sniffed type must match the
 * kind and the declared type, size per kind, safe file name; voice recordings are
 * remuxed to OGG / Opus. The returned id is the `mediaToken` (24 h, this user only).
 */
export const createUpload = async (
  ix: InboxContext,
  input: {
    accountId: Types.ObjectId;
    userId: Types.ObjectId;
    kind: UploadKind;
    bytes: Buffer;
    declaredMime?: string | null;
    fileName?: string | null;
    durationSec?: number | null;
  },
): Promise<InboxUploadDoc> => {
  const max = UPLOAD_MAX_BYTES[input.kind];
  if (input.bytes.length > max) throw tooLarge(max);
  if (!input.bytes.length) throw invalid('corrupt', 'The file is empty');
  const sniffed = sniff(input.bytes);
  let prepared: Prepared;
  if (input.kind === 'voice') {
    prepared = prepareVoice(input.bytes, sniffed, input.durationSec ?? null);
  } else {
    if (!sniffed) throw invalid('not_allowed', "WhatsApp doesn't accept this file type");
    if (!sniffed.kinds.includes(ACCEPTS[input.kind])) {
      throw invalid('type_mismatch', `This file can't be sent as ${input.kind}`);
    }
    prepared = { bytes: input.bytes, sniffed, voice: false, durationSec: null };
  }
  if (input.kind !== 'voice' && !mimeAgrees(input.declaredMime, prepared.sniffed)) {
    throw invalid('type_mismatch', "The file doesn't match its type");
  }
  const id = new Types.ObjectId();
  const key = storageKey({
    accountId: input.accountId.toString(),
    area: 'inbox-uploads',
    id: id.toString(),
    ext: prepared.sniffed.ext,
  });
  await ix.storage.put(key, prepared.bytes, { contentType: prepared.sniffed.mime });
  const doc = await InboxUploadModel.create({
    _id: id,
    accountId: input.accountId,
    userId: input.userId,
    kind: input.kind,
    storageKey: key,
    mimeType: prepared.sniffed.mime,
    size: prepared.bytes.length,
    sha256: createHash('sha256').update(prepared.bytes).digest('hex'),
    fileName:
      input.kind === 'document' || input.kind === 'audio'
        ? sanitizeFileName(input.fileName, prepared.sniffed.ext)
        : null,
    durationSec:
      prepared.durationSec === null
        ? null
        : Math.min(prepared.durationSec, INBOX_LIMITS.voiceNoteMaxSeconds),
    voice: prepared.voice,
    expiresAt: new Date(inboxNow(ix).getTime() + INBOX_LIMITS.orphanUploadTtlMs),
  });
  return doc.toObject({ transform: false });
};
