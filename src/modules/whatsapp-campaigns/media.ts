import { randomUUID } from 'node:crypto';

import type { Types } from 'mongoose';

import { TEMPLATE_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { storageKey } from '../../core/storage/keys';
import { InboxUploadModel, type InboxUploadDoc } from '../../db/models/inbox-upload.model';
import {
  WhatsAppCampaignModel,
  type WhatsAppCampaignDoc,
} from '../../db/models/whatsapp-campaign.model';
import { ValidationError } from '../../shared/errors/app-error';
import { headerFormat } from '../templates/components';

/** A durable campaign-owned copy; the original composer upload can expire normally. */
export const saveCampaignMedia = async (input: {
  token: string;
  accountId: Types.ObjectId;
  userId: Types.ObjectId;
  storage?: StorageProvider;
}) => {
  const upload = await InboxUploadModel.findOne({
    _id: input.token,
    accountId: input.accountId,
    userId: input.userId,
    expiresAt: { $gt: new Date() },
    kind: { $in: ['image', 'video', 'document'] },
  }).lean<InboxUploadDoc>();
  if (!upload || !input.storage)
    throw new ValidationError([
      { path: 'headerMediaToken', message: 'Upload the header file again' },
    ]);
  if (
    upload.size >
    TEMPLATE_LIMITS.headerExampleMaxBytes[upload.kind as 'image' | 'video' | 'document']
  )
    throw new ValidationError([
      { path: 'headerMediaToken', message: 'The file exceeds the WhatsApp template header limit' },
    ]);
  const key = storageKey({
    accountId: input.accountId.toString(),
    area: 'campaign-media',
    id: randomUUID(),
    ext: upload.storageKey.split('.').pop() ?? 'bin',
  });
  await input.storage.put(key, await input.storage.get(upload.storageKey), {
    contentType: upload.mimeType,
  });
  return {
    kind: upload.kind,
    storageKey: key,
    mimeType: upload.mimeType,
    size: upload.size,
    sha256: upload.sha256,
    fileName: upload.fileName,
  };
};

/** Each message owns its own file/upload, so retention cannot delete another recipient's media. */
export const campaignHeaderFor = async (
  campaign: WhatsAppCampaignDoc,
  storage: StorageProvider,
) => {
  const media = campaign.headerMedia;
  if (!media) return undefined;
  const key = storageKey({
    accountId: campaign.accountId.toString(),
    area: 'inbox-media',
    id: randomUUID(),
    ext: media.storageKey.split('.').pop() ?? 'bin',
  });
  await storage.put(key, await storage.get(media.storageKey), { contentType: media.mimeType });
  const upload = await InboxUploadModel.create({
    ...media,
    storageKey: key,
    accountId: campaign.accountId,
    userId: campaign.createdBy,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { mediaToken: upload._id.toString() };
};

export const validateCampaignMedia = (
  media: WhatsAppCampaignDoc['headerMedia'],
  components: Record<string, unknown>[][],
) => {
  if (media && components.some((parts) => headerFormat(parts) !== media.kind.toUpperCase()))
    throw new ValidationError([
      {
        path: 'headerMediaToken',
        message: 'Every selected template must use the same header media type',
      },
    ]);
};

/** Completed recurring runs may share a durable key; remove only unreferenced media. */
export const releaseCampaignMedia = async (
  accountId: Types.ObjectId,
  key: string,
  storage: StorageProvider,
) => {
  if (await WhatsAppCampaignModel.exists({ accountId, 'headerMedia.storageKey': key }))
    return false;
  await storage.delete(key);
  return true;
};
