import mongoose, { Schema, type Model, type Types } from 'mongoose';

export const PHONE_NUMBER_KINDS = ['1600', 'landline', 'mobile', 'other'] as const;
export type PhoneNumberKind = (typeof PHONE_NUMBER_KINDS)[number];
/** `inbound` is used from Phase 19. */
export const PHONE_NUMBER_PURPOSES = ['outbound', 'inbound'] as const;
export type PhoneNumberPurpose = (typeof PHONE_NUMBER_PURPOSES)[number];
export const PHONE_NUMBER_STATUSES = ['active', 'disabled'] as const;
export type PhoneNumberStatus = (typeof PHONE_NUMBER_STATUSES)[number];

export interface PhoneNumberDoc {
  _id: Types.ObjectId;
  /** E.164, unique across the platform. */
  number: string;
  kind: PhoneNumberKind;
  /** `null` = in the pool, not given to an account yet. */
  accountId: Types.ObjectId | null;
  purpose: PhoneNumberPurpose;
  label: string;
  /** DLT principal entity id the number is registered under (regulatory), if known. */
  dltPrincipalEntityId: string | null;
  status: PhoneNumberStatus;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<PhoneNumberDoc>(
  {
    number: { type: String, required: true, match: /^\+[1-9]\d{7,14}$/ },
    kind: { type: String, enum: PHONE_NUMBER_KINDS, required: true },
    accountId: { type: Schema.Types.ObjectId, default: null },
    purpose: { type: String, enum: PHONE_NUMBER_PURPOSES, default: 'outbound', required: true },
    label: { type: String, default: '', trim: true, maxlength: 60 },
    dltPrincipalEntityId: { type: String, default: null, trim: true, maxlength: 40 },
    status: { type: String, enum: PHONE_NUMBER_STATUSES, default: 'active', required: true },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ number: 1 }, { unique: true });
schema.index({ accountId: 1, status: 1 });

/** Caller IDs on the SIP trunk (`phoneNumbers`, Phase 18). */
export const PhoneNumberModel: Model<PhoneNumberDoc> =
  (mongoose.models.PhoneNumber as Model<PhoneNumberDoc> | undefined) ??
  mongoose.model<PhoneNumberDoc>('PhoneNumber', schema, 'phoneNumbers');
