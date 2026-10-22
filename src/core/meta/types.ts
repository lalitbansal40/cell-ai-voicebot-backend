import type { WaLimitTier, WaQuality } from '../../db/models/whatsapp-channel.model';

/** Coexistence sync requests (`POST /{phone}/smb_app_data`). */
export const COEXISTENCE_SYNC_KINDS = ['smb_app_state_sync', 'history'] as const;
export type CoexistenceSyncKind = (typeof COEXISTENCE_SYNC_KINDS)[number];

/** Scopes a business token must carry for a connect (debug_token). */
export const REQUIRED_META_SCOPES = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
] as const;

export interface MetaAccessToken {
  accessToken: string;
  tokenType: string | null;
}

export interface MetaDebugToken {
  isValid: boolean;
  type: string | null;
  appId: string | null;
  /** The Meta user that granted access (deauthorize / data deletion callbacks). */
  userId: string | null;
  /** `null` = never expires (`expires_at: 0`). */
  expiresAt: Date | null;
  scopes: string[];
  /** Target ids of the `whatsapp_business_management` granular scope. */
  grantedWabaIds: string[];
}

export interface MetaWabaSummary {
  id: string;
  name: string | null;
}

export interface MetaBusinessSummary {
  id: string;
  name: string | null;
  wabas: MetaWabaSummary[];
}

export interface MetaWaba {
  id: string;
  name: string | null;
  currency: string | null;
  timezoneId: string | null;
  templateNamespace: string | null;
  reviewStatus: string | null;
  businessVerificationStatus: string | null;
  businessId: string | null;
  businessName: string | null;
  /** Present when the WABA has a payment method / credit line. */
  primaryFundingId: string | null;
}

export interface MetaPhoneSummary {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: string | null;
}

export interface MetaPhone {
  id: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  nameStatus: string | null;
  newNameStatus: string | null;
  qualityRating: WaQuality;
  messagingLimitTier: WaLimitTier | null;
  codeVerificationStatus: string | null;
  platformType: string | null;
  throughputLevel: string | null;
  accountMode: string | null;
  status: string | null;
  isOfficialBusinessAccount: boolean;
  isOnBizApp: boolean;
}

export interface MetaCreditLineAttach {
  allocationConfigId: string;
}

export interface MetaAllocation {
  id: string;
  receivingCredentialId: string | null;
}

/**
 * Everything Phase 9 needs from the Meta Graph API. Two implementations:
 * `createGraphMetaClient` (real HTTP) and `createFakeMetaClient` (dev / tests / E2E).
 * Every method throws `MetaApiError` on failure.
 */
export interface MetaClient {
  readonly provider: 'meta' | 'fake';
  exchangeCode(code: string): Promise<MetaAccessToken>;
  debugToken(token: string): Promise<MetaDebugToken>;
  listOwnedWabas(token: string): Promise<MetaWabaSummary[]>;
  listBusinessesWithWabas(token: string): Promise<MetaBusinessSummary[]>;
  getWaba(token: string, wabaId: string): Promise<MetaWaba>;
  listPhoneNumbers(token: string, wabaId: string): Promise<MetaPhoneSummary[]>;
  getPhoneNumber(token: string, phoneNumberId: string): Promise<MetaPhone>;
  subscribeApp(token: string, wabaId: string): Promise<void>;
  unsubscribeApp(token: string, wabaId: string): Promise<void>;
  /** Id of the user / System User a token belongs to (cached per token). */
  getTokenOwner(token: string): Promise<string>;
  assignSystemUser(token: string, wabaId: string, userId: string): Promise<void>;
  /** Attaches the platform credit line (`META_CREDIT_LINE_ID`, System User token). */
  attachCreditLine(wabaId: string, currency: string): Promise<MetaCreditLineAttach>;
  getAllocation(allocationConfigId: string): Promise<MetaAllocation>;
  registerPhone(token: string, phoneNumberId: string, pin: string): Promise<void>;
  requestCoexistenceSync(
    token: string,
    phoneNumberId: string,
    kind: CoexistenceSyncKind,
  ): Promise<{ requestId: string | null }>;
}

export interface MetaApiErrorInit {
  /** HTTP status (0 = network error / timeout / not configured). */
  status: number;
  code: number | null;
  subcode: number | null;
  type: string | null;
  message: string;
  fbtraceId: string | null;
  retryable: boolean;
  tokenInvalid: boolean;
}

/** A failed Graph call. `message` is always scrubbed of tokens / secrets / codes. */
export class MetaApiError extends Error implements MetaApiErrorInit {
  readonly status: number;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly fbtraceId: string | null;
  readonly retryable: boolean;
  readonly tokenInvalid: boolean;

  constructor(init: MetaApiErrorInit) {
    super(init.message);
    this.name = 'MetaApiError';
    this.status = init.status;
    this.code = init.code;
    this.subcode = init.subcode;
    this.type = init.type;
    this.fbtraceId = init.fbtraceId;
    this.retryable = init.retryable;
    this.tokenInvalid = init.tokenInvalid;
  }
}

export const isMetaApiError = (err: unknown): err is MetaApiError => err instanceof MetaApiError;
