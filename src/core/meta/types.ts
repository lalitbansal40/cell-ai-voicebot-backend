import type { Readable } from 'node:stream';

import type { WaLimitTier, WaQuality } from '../../db/models/whatsapp-channel.model';

/** Coexistence sync requests (`POST /{phone}/smb_app_data`). */
export const COEXISTENCE_SYNC_KINDS = ['smb_app_state_sync', 'history'] as const;
export type CoexistenceSyncKind = (typeof COEXISTENCE_SYNC_KINDS)[number];

/** Scopes a business token must carry for a connect (debug_token). */
export const REQUIRED_META_SCOPES = [
  'whatsapp_business_management',
  'whatsapp_business_messaging',
] as const;

/**
 * Hosts a media URL from `GET /{media-id}` may point at (SSRF guard for the
 * download). Re-check against Meta's media reference when the Graph version changes.
 */
export const META_MEDIA_HOST_SUFFIXES = [
  '.fbsbx.com',
  '.fbcdn.net',
  '.whatsapp.net',
  '.facebook.com',
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

/** `POST /{phone}/messages` body (built by `payloads.ts`). */
export type MetaMessagePayload = Record<string, unknown> & {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: string;
};

export interface MetaSendResult {
  waMessageId: string;
}

export interface MetaMediaUpload {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

/** `GET /{media-id}` — a short-lived URL (needs the business token to download). */
export interface MetaMediaUrl {
  url: string;
  mimeType: string | null;
  sha256: string | null;
  size: number | null;
}

export interface MetaMediaDownload {
  stream: Readable;
  contentType: string | null;
  contentLength: number | null;
}

export interface MetaBlockResult {
  /** waIds Meta blocked / unblocked. */
  done: string[];
  failed: { waId: string; code: number | null; message: string }[];
}

export const BUSINESS_VERTICALS = [
  'UNDEFINED',
  'OTHER',
  'AUTO',
  'BEAUTY',
  'APPAREL',
  'EDU',
  'ENTERTAIN',
  'EVENT_PLAN',
  'FINANCE',
  'GROCERY',
  'GOVT',
  'HOTEL',
  'HEALTH',
  'NONPROFIT',
  'PROF_SERVICES',
  'RETAIL',
  'TRAVEL',
  'RESTAURANT',
  'NOT_A_BIZ',
] as const;
export type BusinessVertical = (typeof BUSINESS_VERTICALS)[number];

export interface MetaBusinessProfile {
  about: string | null;
  address: string | null;
  description: string | null;
  email: string | null;
  profilePictureUrl: string | null;
  websites: string[];
  vertical: string | null;
}

export interface MetaBusinessProfileUpdate {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  websites?: string[];
  vertical?: BusinessVertical;
  /** From `uploadProfilePhoto`. */
  profilePictureHandle?: string;
}

/* ── Phase 11: templates + pricing ── */

/**
 * Reactions and WhatsApp billing (re-checked 23 Oct 2026): Meta's pricing page bills every
 * delivered message by category and does **not** list reactions as free, so a reaction is
 * held like a service reply and released when Meta reports `billable: false`.
 */
export const REACTIONS_BILLABLE = true;

/** A template as Meta returns it (`GET /{waba}/message_templates`). */
export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  subCategory: string | null;
  parameterFormat: 'positional' | 'named';
  components: Record<string, unknown>[];
  qualityScore: string | null;
  rejectedReason: string | null;
  ttlSeconds: number | null;
}

export interface MetaTemplatePage {
  templates: MetaTemplate[];
  /** Cursor of the next page; null on the last one. */
  after: string | null;
}

export interface MetaTemplateCreate {
  name: string;
  language: string;
  category: string;
  parameterFormat: 'positional' | 'named';
  components: Record<string, unknown>[];
  ttlSeconds?: number | null;
}

export interface MetaTemplateCreated {
  id: string;
  status: string;
  category: string;
}

export interface MetaTemplateEdit {
  category?: string;
  components?: Record<string, unknown>[];
  ttlSeconds?: number | null;
}

/** A file for Meta's resumable upload (template header examples, profile photos). */
export interface MetaUploadFile {
  bytes: Buffer;
  mimeType: string;
  fileName?: string | null;
}

/** One `pricing_analytics` data point (cost in the WABA currency, major units). */
export interface MetaPricingPoint {
  start: Date;
  end: Date;
  country: string | null;
  category: string | null;
  pricingType: string | null;
  tier: string | null;
  volume: number;
  cost: number;
}

/* ── Phase 12: WhatsApp calling (Cloud API Calling reference, re-checked 24 Oct 2026) ── */

/** A business-initiated call (`POST /{phone}/calls`, `action: connect`). SDP is never logged. */
export interface MetaStartCall {
  /** The customer's WhatsApp id (digits) — or `recipient` (BSUID) when no phone is known. */
  to?: string | null;
  recipient?: string | null;
  sdpOffer: string;
  /** Echoed in status / terminate webhooks (our call id). */
  bizOpaque?: string | null;
}

export type MetaOnOff = 'ENABLED' | 'DISABLED';
export type MetaWeekDay =
  'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY' | 'SUNDAY';

export interface MetaCallHours {
  status: MetaOnOff;
  timezoneId: string;
  weekly: { day: MetaWeekDay; open: string; close: string }[];
  holidays: { date: string; start: string; end: string }[];
}

export interface MetaCallingRestriction {
  /** `RESTRICTED_BUSINESS_INITIATED_CALLING` / `RESTRICTED_USER_INITIATED_CALLING` / … */
  type: string;
  reason: string | null;
  expiresAt: Date | null;
}

/** The `calling` block of `GET /{phone}/settings` (unknown values kept as strings). */
export interface MetaCallingSettings {
  status: string | null;
  callIconVisibility: string | null;
  /** `call_icons.restrict_to_user_countries` (`[]` = everywhere). */
  iconCountries: string[];
  callHours: MetaCallHours | null;
  callbackPermissionStatus: string | null;
  sipStatus: string | null;
  restrictions: MetaCallingRestriction[];
}

/** `POST /{phone}/settings` — only the fields given are sent. */
export interface MetaCallingSettingsUpdate {
  status?: MetaOnOff;
  callIconVisibility?: 'DEFAULT' | 'DISABLE_ALL';
  iconCountries?: string[];
  callHours?: MetaCallHours;
  callbackPermissionStatus?: MetaOnOff;
}

export interface MetaCallPermissionLimit {
  /** ISO 8601 duration (`PT24H`, `P7D`). */
  timePeriod: string;
  maxAllowed: number;
  currentUsage: number;
  limitExpiresAt: Date | null;
}

/** `GET /{phone}/call_permissions` — Meta's view of the customer's permission. */
export interface MetaCallPermission {
  status: 'no_permission' | 'temporary' | 'permanent';
  expiresAt: Date | null;
  actions: { action: string; canPerform: boolean; limits: MetaCallPermissionLimit[] }[];
}

/** One `call_analytics` data point (business-initiated calls; cost in the WABA currency). */
export interface MetaCallAnalyticsPoint {
  start: Date;
  end: Date;
  direction: string | null;
  country: string | null;
  count: number;
  /** Major units; null when Meta leaves it out (e.g. credit-line accounts). */
  cost: number | null;
  averageDurationSec: number | null;
}

/**
 * Everything Phases 9–12 need from the Meta Graph API. Two implementations:
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
  /* ── Phase 10: inbox ── */
  sendMessage(
    token: string,
    phoneNumberId: string,
    payload: MetaMessagePayload,
  ): Promise<MetaSendResult>;
  /** Read receipt for `waMessageId` (and earlier ones); `typing` adds the typing indicator. */
  markRead(
    token: string,
    phoneNumberId: string,
    waMessageId: string,
    options?: { typing?: boolean },
  ): Promise<void>;
  uploadMedia(token: string, phoneNumberId: string, media: MetaMediaUpload): Promise<string>;
  getMediaUrl(token: string, mediaId: string, phoneNumberId: string): Promise<MetaMediaUrl>;
  /** Streams a media URL (host allowlist, no redirects, aborts past `maxBytes`). */
  downloadMedia(
    token: string,
    url: string,
    options: { maxBytes: number },
  ): Promise<MetaMediaDownload>;
  blockUsers(token: string, phoneNumberId: string, waIds: string[]): Promise<MetaBlockResult>;
  unblockUsers(token: string, phoneNumberId: string, waIds: string[]): Promise<MetaBlockResult>;
  getBusinessProfile(token: string, phoneNumberId: string): Promise<MetaBusinessProfile>;
  updateBusinessProfile(
    token: string,
    phoneNumberId: string,
    fields: MetaBusinessProfileUpdate,
  ): Promise<void>;
  /** Resumable upload of a profile photo → handle for `updateBusinessProfile`. */
  uploadProfilePhoto(token: string, bytes: Buffer, mimeType: string): Promise<string>;
  /* ── Phase 11: templates + pricing ── */
  listTemplates(
    token: string,
    wabaId: string,
    options?: { after?: string | null; limit?: number },
  ): Promise<MetaTemplatePage>;
  createTemplate(
    token: string,
    wabaId: string,
    body: MetaTemplateCreate,
  ): Promise<MetaTemplateCreated>;
  editTemplate(token: string, templateId: string, body: MetaTemplateEdit): Promise<void>;
  /** `hsmId` deletes one language; without it every language of the name goes. */
  deleteTemplate(
    token: string,
    wabaId: string,
    target: { name: string; hsmId?: string | null },
  ): Promise<void>;
  /** Resumable upload of a template header example → handle (`header_handle`). */
  uploadExample(token: string, file: MetaUploadFile): Promise<string>;
  /** Daily cost / volume per pricing category, type and country (`pricing_analytics`). */
  getPricingAnalytics(
    token: string,
    wabaId: string,
    range: { start: Date; end: Date },
  ): Promise<MetaPricingPoint[]>;
  /* ── Phase 12: calling ── */
  /** Business-initiated call → Meta's call id (`wacid.…`). */
  startCall(
    token: string,
    phoneNumberId: string,
    call: MetaStartCall,
  ): Promise<{ waCallId: string }>;
  /** User-initiated call: our SDP answer before the media is ready (optional step). */
  preAcceptCall(
    token: string,
    phoneNumberId: string,
    waCallId: string,
    sdpAnswer: string,
  ): Promise<void>;
  acceptCall(
    token: string,
    phoneNumberId: string,
    waCallId: string,
    sdpAnswer: string,
    bizOpaque?: string | null,
  ): Promise<void>;
  rejectCall(token: string, phoneNumberId: string, waCallId: string): Promise<void>;
  terminateCall(token: string, phoneNumberId: string, waCallId: string): Promise<void>;
  getPhoneSettings(token: string, phoneNumberId: string): Promise<MetaCallingSettings>;
  updateCallingSettings(
    token: string,
    phoneNumberId: string,
    calling: MetaCallingSettingsUpdate,
  ): Promise<void>;
  /** `waId` = the customer's WhatsApp id (digits) or BSUID (`recipient`). */
  /** Daily business-initiated call count / cost per country (`call_analytics`, reconciliation). */
  getCallAnalytics(
    token: string,
    wabaId: string,
    range: { start: Date; end: Date },
  ): Promise<MetaCallAnalyticsPoint[]>;
  getCallPermissions(
    token: string,
    phoneNumberId: string,
    waId: string,
  ): Promise<MetaCallPermission>;
}

/** Is `url` a Meta media host (or one of `extraHosts`, exact match — tests / fake)? */
export const isAllowedMediaUrl = (url: string, extraHosts: readonly string[] = []): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (extraHosts.includes(parsed.host.toLowerCase()) || extraHosts.includes(host)) return true;
  return (
    parsed.protocol === 'https:' && META_MEDIA_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
};

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
