import { randomUUID } from 'node:crypto';

import type { Types } from 'mongoose';

import { TEMPLATE_LIMITS } from '../../config/limits';
import { storageKey } from '../../core/storage/keys';
import {
  WhatsAppTemplateModel,
  type WhatsAppTemplateDoc,
} from '../../db/models/whatsapp-template.model';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { mimeAgrees, sniff } from '../inbox/sniff';
import type { WaActor } from '../whatsapp/channel-status';

import { templateMetaError, templateToken, wabaChannel } from './channel';
import { headerFormat } from './components';
import { templateNow, type TemplateContext } from './context';
import { auditTemplate } from './notify';
import { templateDetail } from './template-json';

/** Header format → what Meta takes as its example (sniffed, not the browser's claim). */
const ALLOWED: Record<'IMAGE' | 'VIDEO' | 'DOCUMENT', readonly string[]> = {
  IMAGE: ['image/jpeg', 'image/png'],
  VIDEO: ['video/mp4'],
  DOCUMENT: ['application/pdf'],
};

const safeName = (name: string | null | undefined, ext: string) => {
  const base = (name ?? '')
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .trim()
    .slice(0, 150);
  return base || `example.${ext}`;
};

export interface ExampleFile {
  bytes: Buffer;
  mimeType: string | null;
  fileName: string | null;
}

/**
 * Example file of a media header: magic bytes must match the header format, size per
 * kind (image 5 MB, video 16 MB, document 100 MB), stored under `template-media`, then
 * uploaded to Meta (resumable upload) for its handle. Drafts and editable templates only.
 */
export const uploadHeaderExample = async (
  tx: TemplateContext,
  accountId: Types.ObjectId,
  actor: WaActor,
  templateId: string,
  file: ExampleFile,
) => {
  if (!tx.storage) throw new AppError('INTERNAL_ERROR', 'File storage is not configured');
  const t = await WhatsAppTemplateModel.findOne({
    _id: templateId,
    accountId,
  }).lean<WhatsAppTemplateDoc>();
  if (!t) throw new AppError('TEMPLATE_NOT_FOUND');
  if (!['DRAFT', 'APPROVED', 'REJECTED', 'PAUSED'].includes(t.status) || !t.editable) {
    throw new AppError('TEMPLATE_EDIT_NOT_ALLOWED', "This template's example can't change now", [
      { path: 'status', message: t.status },
    ]);
  }
  const format = headerFormat(t.components);
  if (format !== 'IMAGE' && format !== 'VIDEO' && format !== 'DOCUMENT') {
    throw new ValidationError([{ path: 'file', message: 'This template has no media header' }]);
  }
  const kind = format.toLowerCase() as 'image' | 'video' | 'document';
  const max = TEMPLATE_LIMITS.headerExampleMaxBytes[kind];
  if (file.bytes.length === 0) throw new ValidationError([{ path: 'file', message: 'Empty file' }]);
  if (file.bytes.length > max) {
    throw new AppError('WHATSAPP_MEDIA_TOO_LARGE', undefined, [
      { path: 'file', message: `At most ${String(Math.round(max / 1024 / 1024))} MB` },
    ]);
  }
  const sniffed = sniff(file.bytes);
  if (!sniffed || !ALLOWED[format].includes(sniffed.mime) || !mimeAgrees(file.mimeType, sniffed)) {
    throw new AppError('WHATSAPP_MEDIA_INVALID', undefined, [
      { path: 'file', message: `Use ${ALLOWED[format].join(' or ')} for this header` },
    ]);
  }
  const channel = await wabaChannel(accountId, t.wabaId);
  const { token } = await templateToken(tx, channel._id);
  const fileName = safeName(file.fileName, sniffed.ext);
  let handle: string;
  try {
    handle = await tx.wa.meta.uploadExample(token, {
      bytes: file.bytes,
      mimeType: sniffed.mime,
      fileName,
    });
  } catch (err) {
    throw await templateMetaError(tx, channel, err);
  }
  const key = storageKey({
    accountId: accountId.toString(),
    area: 'template-media',
    id: randomUUID(),
    ext: sniffed.ext,
  });
  await tx.storage.put(key, file.bytes, { contentType: sniffed.mime });
  const previous = t.headerMedia?.storageKey;
  const now = templateNow(tx);
  const updated = await WhatsAppTemplateModel.findOneAndUpdate(
    { _id: t._id, accountId },
    {
      $set: {
        headerMedia: {
          storageKey: key,
          mimeType: sniffed.mime,
          size: file.bytes.length,
          fileName,
          handle,
          handleAt: now,
        },
        updatedBy: actor.id,
      },
    },
    { returnDocument: 'after' },
  ).lean<WhatsAppTemplateDoc>();
  if (!updated) throw new AppError('TEMPLATE_NOT_FOUND');
  if (previous && previous !== key) await tx.storage.delete(previous).catch(() => undefined);
  await auditTemplate(updated, 'template.updated', actor, { fields: ['headerMedia'] });
  return templateDetail(updated, now);
};
