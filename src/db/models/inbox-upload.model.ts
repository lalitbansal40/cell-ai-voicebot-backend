import mongoose, { Schema, type Model, type Types } from 'mongoose';

import { INBOX_LIMITS } from '../../config/limits';
import { basePlugin } from '../plugins/base';
import { tenantPlugin } from '../plugins/tenant';

export const UPLOAD_KINDS = ['image', 'video', 'audio', 'voice', 'document', 'sticker'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export interface InboxUploadDoc {
  _id: Types.ObjectId;
  accountId: Types.ObjectId;
  /** Only this user may send it. */
  userId: Types.ObjectId;
  kind: UploadKind;
  storageKey: string;
  mimeType: string;
  size: number;
  sha256: string;
  fileName: string | null;
  durationSec: number | null;
  /** Voice note (OGG / Opus mono); a browser that records M4A sends an audio file. */
  voice: boolean;
  /** Unused uploads are deleted (file + row) by the retention job after this. */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<InboxUploadDoc>({
  userId: { type: Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: UPLOAD_KINDS, required: true },
  storageKey: { type: String, required: true },
  mimeType: { type: String, required: true, maxlength: 120 },
  size: { type: Number, required: true, min: 0 },
  sha256: { type: String, required: true },
  fileName: { type: String, default: null, maxlength: INBOX_LIMITS.fileNameMax },
  durationSec: { type: Number, default: null, min: 0 },
  voice: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true },
});
schema.plugin(tenantPlugin);
schema.plugin(basePlugin);
// not a TTL index: the retention job deletes the stored file first
schema.index({ expiresAt: 1 });

/**
 * A file uploaded from the inbox composer, waiting to be sent (data-model.md §2.8).
 * Its id is the `mediaToken`; sending copies it into the message and deletes the row.
 */
export const InboxUploadModel: Model<InboxUploadDoc> =
  (mongoose.models.InboxUpload as Model<InboxUploadDoc> | undefined) ??
  mongoose.model<InboxUploadDoc>('InboxUpload', schema, 'inboxUploads');
