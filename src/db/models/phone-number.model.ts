import mongoose, { Schema, type Model, type Types } from 'mongoose';

import {
  callHoursProblems,
  HHMM_PATTERN,
  ISO_DATE_PATTERN,
  WEEK_DAYS,
  type CallHours,
} from './whatsapp-channel.model';

export const PHONE_NUMBER_KINDS = ['1600', 'landline', 'mobile', 'other'] as const;
export type PhoneNumberKind = (typeof PHONE_NUMBER_KINDS)[number];
/** `inbound` / `both` take customer calls (Phase 20); `outbound` / `both` are caller IDs. */
export const PHONE_NUMBER_PURPOSES = ['outbound', 'inbound', 'both'] as const;
/** Purposes a number may be the caller ID of an outgoing call with. */
export const CALLER_ID_PURPOSES: readonly PhoneNumberPurpose[] = ['outbound', 'both'];
/** Purposes a number may take incoming calls with. */
export const INBOUND_PURPOSES: readonly PhoneNumberPurpose[] = ['inbound', 'both'];
export type PhoneNumberPurpose = (typeof PHONE_NUMBER_PURPOSES)[number];
export const PHONE_NUMBER_STATUSES = ['active', 'disabled'] as const;
export type PhoneNumberStatus = (typeof PHONE_NUMBER_STATUSES)[number];

/**
 * Who answers a call to the number (Phase 20): a flow / AI agent, the team in the browser,
 * AI that can hand over to the team, or the team with AI when nobody picks up.
 */
export const SIP_INBOUND_ROUTES = ['ai', 'team', 'ai_then_team', 'team_then_ai'] as const;
export type SipInboundRoute = (typeof SIP_INBOUND_ROUTES)[number];
export const AFTER_HOURS_ACTIONS = ['message', 'ai', 'hangup'] as const;
export type AfterHoursAction = (typeof AFTER_HOURS_ACTIONS)[number];

export const INBOUND_LIMITS = {
  greetingMax: 200,
  messageMax: 200,
  ringTimeoutMinSec: 10,
  ringTimeoutDefaultSec: 30,
  ringUsersMax: 50,
} as const;

export const DEFAULT_AFTER_HOURS_MESSAGE =
  'Abhi hamara office band hai. Kripya office time me call karein. Dhanyavaad.';

export interface PhoneNumberInbound {
  enabled: boolean;
  route: SipInboundRoute;
  program: { kind: 'flow' | 'agent'; id: Types.ObjectId } | null;
  /** Said before the team rings ('' = none). */
  greeting: string;
  /** `null` = every eligible team member. */
  ringUserIds: Types.ObjectId[] | null;
  ringTimeoutSec: number;
  callHours: CallHours;
  afterHours: { action: AfterHoursAction; message: string };
  updatedBy: Types.ObjectId | null;
  updatedAt: Date | null;
}

export const defaultInbound = (): PhoneNumberInbound => ({
  enabled: false,
  route: 'ai',
  program: null,
  greeting: '',
  ringUserIds: null,
  ringTimeoutSec: INBOUND_LIMITS.ringTimeoutDefaultSec,
  callHours: { enabled: false, timezone: 'Asia/Kolkata', weekly: [], holidays: [] },
  afterHours: { action: 'message', message: DEFAULT_AFTER_HOURS_MESSAGE },
  updatedBy: null,
  updatedAt: null,
});

/** Problems of inbound settings beyond the field types (empty = valid). */
export const inboundProblems = (i: PhoneNumberInbound): string[] => {
  const problems = callHoursProblems(i.callHours);
  const needsProgram = i.route !== 'team' || (i.callHours.enabled && i.afterHours.action === 'ai');
  if (i.enabled && needsProgram && !i.program) problems.push('Choose a flow or AI agent');
  return problems;
};

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
  /** Incoming calls (Phase 20); set by the account. */
  inbound: PhoneNumberInbound;
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
    inbound: {
      type: new Schema<PhoneNumberInbound>(
        {
          enabled: { type: Boolean, default: false },
          route: { type: String, enum: SIP_INBOUND_ROUTES, default: 'ai' },
          program: {
            type: new Schema(
              {
                kind: { type: String, enum: ['flow', 'agent'], required: true },
                id: { type: Schema.Types.ObjectId, required: true },
              },
              { _id: false },
            ),
            default: null,
          },
          greeting: {
            type: String,
            default: '',
            trim: true,
            maxlength: INBOUND_LIMITS.greetingMax,
          },
          ringUserIds: {
            type: [Schema.Types.ObjectId],
            default: null,
            validate: {
              validator: (v: Types.ObjectId[] | null) =>
                v === null || v.length <= INBOUND_LIMITS.ringUsersMax,
              message: 'Too many team members',
            },
          },
          ringTimeoutSec: {
            type: Number,
            default: INBOUND_LIMITS.ringTimeoutDefaultSec,
            min: INBOUND_LIMITS.ringTimeoutMinSec,
            max: 300,
          },
          callHours: {
            type: new Schema<CallHours>(
              {
                enabled: { type: Boolean, default: false },
                timezone: { type: String, default: 'Asia/Kolkata', maxlength: 64 },
                weekly: {
                  type: [
                    new Schema(
                      {
                        day: { type: String, enum: WEEK_DAYS, required: true },
                        open: { type: String, required: true, match: HHMM_PATTERN },
                        close: { type: String, required: true, match: HHMM_PATTERN },
                      },
                      { _id: false },
                    ),
                  ],
                  default: [],
                },
                holidays: {
                  type: [
                    new Schema(
                      {
                        date: { type: String, required: true, match: ISO_DATE_PATTERN },
                        start: { type: String, required: true, match: HHMM_PATTERN },
                        end: { type: String, required: true, match: HHMM_PATTERN },
                      },
                      { _id: false },
                    ),
                  ],
                  default: [],
                },
              },
              { _id: false },
            ),
            default: () => defaultInbound().callHours,
          },
          afterHours: {
            action: { type: String, enum: AFTER_HOURS_ACTIONS, default: 'message' },
            message: {
              type: String,
              default: DEFAULT_AFTER_HOURS_MESSAGE,
              trim: true,
              maxlength: INBOUND_LIMITS.messageMax,
            },
          },
          updatedBy: { type: Schema.Types.ObjectId, default: null },
          updatedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: defaultInbound,
      validate: {
        validator: (v: PhoneNumberInbound) => inboundProblems(v).length === 0,
        message: (props: { value: PhoneNumberInbound }) => inboundProblems(props.value).join('; '),
      },
    },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ number: 1 }, { unique: true });
schema.index({ accountId: 1, status: 1 });

/** Caller IDs on the SIP trunk (`phoneNumbers`, Phase 18). */
export const PhoneNumberModel: Model<PhoneNumberDoc> =
  (mongoose.models.PhoneNumber as Model<PhoneNumberDoc> | undefined) ??
  mongoose.model<PhoneNumberDoc>('PhoneNumber', schema, 'phoneNumbers');
