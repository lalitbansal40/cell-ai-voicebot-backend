import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import { INBOX_LIMITS } from '../../config/limits';
import { isMetaApiError } from '../../core/meta';
import { storageKey } from '../../core/storage';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../db/models/whatsapp-channel.model';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { markNeedsReconnect } from '../whatsapp/channel-status';
import { openSecret } from '../whatsapp/context';

import { inboxNow, type InboxContext } from './context';
import { emitMessageUpdated } from './events';
import { mimeAgrees, sniff } from './sniff';

export type DownloadOutcome = 'ready' | 'failed' | 'expired' | 'skipped';

/** Not retried: the media can't become valid (wrong type, too large, gone). */
class PermanentMediaError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PermanentMediaError';
  }
}

const setMedia = async (m: MessageDoc, set: Record<string, unknown>) => {
  const updated = await MessageModel.findOneAndUpdate(
    { _id: m._id },
    { $set: Object.fromEntries(Object.entries(set).map(([k, v]) => [`media.${k}`, v])) },
    { returnDocument: 'after' },
  ).lean<MessageDoc>();
  if (updated) emitMessageUpdated(updated);
  return updated;
};

const readAll = async (stream: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

/**
 * `media.download` job (PHASE_10_PLAN §1f): Meta media id → short-lived URL → bytes
 * (Bearer, host allowlist, size cap) → sniffed and checked against Meta's type →
 * storage `accounts/<id>/inbox-media/<messageId>.<ext>` → `ready`. Retryable errors
 * are rethrown (BullMQ retries); on the last attempt / permanent errors → `failed`;
 * media older than 7 days → `expired` (Meta deleted it).
 */
export const downloadInboundMedia = async (
  ix: InboxContext,
  messageId: string,
  options: { finalAttempt: boolean },
): Promise<DownloadOutcome> => {
  const m = await MessageModel.findById(messageId).lean<MessageDoc>();
  if (!m?.media?.metaMediaId || m.media.status === 'ready') return 'skipped';
  const now = inboxNow(ix);
  if (now.getTime() - m.at.getTime() > INBOX_LIMITS.inboundMediaValidMs) {
    await setMedia(m, { status: 'expired', error: 'Media is older than 7 days' });
    return 'expired';
  }
  const channel = await WhatsAppChannelModel.findById(m.channelId)
    .select('+tokenSealed')
    .lean<WhatsAppChannelDoc>();
  try {
    if (!channel?.tokenSealed || !channel.phoneNumberId) {
      throw new PermanentMediaError('The WhatsApp number is not connected');
    }
    const token = openSecret(ix.wa, channel.tokenSealed);
    const info = await ix.wa.meta.getMediaUrl(token, m.media.metaMediaId, channel.phoneNumberId);
    if (info.size !== null && info.size > INBOX_LIMITS.inboundMediaMaxBytes) {
      throw new PermanentMediaError('Media is larger than allowed');
    }
    const download = await ix.wa.meta.downloadMedia(token, info.url, {
      maxBytes: INBOX_LIMITS.inboundMediaMaxBytes,
    });
    const bytes = await readAll(download.stream);
    const sniffed = sniff(bytes);
    const declared = info.mimeType ?? m.media.mimeType;
    if (!sniffed || !mimeAgrees(declared, sniffed)) {
      throw new PermanentMediaError("The media doesn't match its type");
    }
    const key = storageKey({
      accountId: m.accountId.toString(),
      area: 'inbox-media',
      id: m._id.toString(),
      ext: sniffed.ext,
    });
    await ix.storage.put(key, bytes, { contentType: sniffed.mime });
    await setMedia(m, {
      status: 'ready',
      storageKey: key,
      mimeType: sniffed.mime,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      error: null,
    });
    return 'ready';
  } catch (err) {
    if (isMetaApiError(err) && err.tokenInvalid && channel) {
      await markNeedsReconnect(ix.wa, channel);
    }
    const permanent =
      err instanceof PermanentMediaError ||
      (isMetaApiError(err) && (!err.retryable || err.tokenInvalid));
    getLogger().warn(
      {
        messageId,
        permanent,
        code: isMetaApiError(err) ? err.code : null,
        type: isMetaApiError(err) ? err.type : (err as Error).name,
      },
      'inbox: media download failed',
    );
    if (permanent || options.finalAttempt) {
      await setMedia(m, {
        status: 'failed',
        error: err instanceof PermanentMediaError ? err.reason : "Media couldn't be downloaded",
      });
      return 'failed';
    }
    throw err;
  }
};

/** Manual retry of a failed inbound download (< 7 days). */
export const retryMediaDownload = async (ix: InboxContext, m: MessageDoc): Promise<void> => {
  if (m.direction !== 'in' || !m.media?.metaMediaId) throw new NotFoundError('Media not found');
  if (m.media.status === 'ready') return;
  if (inboxNow(ix).getTime() - m.at.getTime() > INBOX_LIMITS.inboundMediaValidMs) {
    throw new AppError('INBOX_MEDIA_EXPIRED');
  }
  await setMedia(m, { status: 'pending', error: null });
  await ix.jobs.enqueueMediaDownload(m._id.toString());
};

/** Signed storage link for a message's media (5 min). */
export const mediaLink = async (ix: InboxContext, m: MessageDoc): Promise<string> => {
  if (!m.media?.storageKey || m.media.status !== 'ready')
    throw new NotFoundError('Media not ready');
  return ix.storage.signedUrl(m.media.storageKey, { expiresInSec: INBOX_LIMITS.mediaLinkTtlSec });
};
