/** Request-size and rate limits (docs/conventions/api.md §11, PHASE_1_PLAN T1.6). */
export const JSON_BODY_LIMIT = '1mb';
export const URLENCODED_BODY_LIMIT = '100kb';

/**
 * Global per-IP limit for every API request — a flood guard, not a quota.
 * 1,200 / min (20 / s): a team behind one office NAT loads ~10 requests per
 * page (contacts, fields, lists, tags, refresh, WS ticket…); 300 / min locked
 * out ~20 people working together (found by the Phase 3 E2E suite).
 */
export const GLOBAL_RATE_LIMIT = { windowMs: 60_000, limit: 1200 } as const;

/** Preset for sensitive routes (login, password reset, OTP) — mounted in Phase 2. */
export const STRICT_RATE_LIMIT = { windowMs: 15 * 60_000, limit: 10 } as const;

/** Paths never rate-limited or access-logged (health checks land in T1.9). */
export const UNLIMITED_PATHS: readonly string[] = ['/health', '/ready'];

/** Default lifetime of signed download URLs (seconds). */
export const SIGNED_URL_TTL_SEC = 900;

/**
 * Public auth routes (signup, OTP, login, refresh, reset, accept invite):
 * per IP **and** route. Generous enough for an office behind one NAT;
 * brute force is stopped by the per-email lockout and OTP attempt caps.
 */
export const AUTH_RATE_LIMIT = { windowMs: 15 * 60_000, limit: 30 } as const;

/**
 * `/auth/refresh` runs on every page load and tab (and every ~14 min), and is
 * authenticated by an unguessable httpOnly cookie — so it gets far more room
 * than the brute-forceable routes. Same window, per IP.
 */
export const AUTH_REFRESH_RATE_LIMIT = 600;

/** Contacts, imports and exports (PHASE_3_PLAN §1e). */
export const CONTACT_LIMITS = {
  importMaxBytes: 10 * 1024 * 1024,
  importMaxRows: 50_000,
  importMaxColumns: 100,
  /** Sum of uncompressed entry sizes in an .xlsx (zip-bomb guard). */
  xlsxMaxUncompressedBytes: 100 * 1024 * 1024,
  importBatchSize: 500,
  importSampleRows: 20,
  importSampleValues: 3,
  problemRowsInline: 100,
  customFieldsPerAccount: 50,
  listsPerAccount: 500,
  segmentsPerAccount: 100,
  segmentConditions: 20,
  tagsPerContact: 20,
  listsPerContact: 50,
  textValueMaxLength: 1000,
  bulkIdsMax: 1000,
  bulkFilterMax: 100_000,
  exportMaxRows: 100_000,
  exportBatchSize: 1000,
  progressThrottleMs: 1000,
  exportUrlTtlSec: 900,
  exportRetentionHours: 24,
  importFileRetentionDays: 30,
  deletedContactRetentionDays: 30,
  /** Redis lock TTL for one running import / bulk / export per account. */
  jobLockTtlMs: 30 * 60_000,
} as const;

/** Wallet, billing & payments (PHASE_4_PLAN §1, integers only). */
export const BILLING_LIMITS = {
  /** ₹100 – ₹5,00,000 per top-up, whole rupees. */
  topupMinMicros: 100_000_000,
  topupMaxMicros: 500_000_000_000,
  topupPresetsMicros: [500_000_000, 1_000_000_000, 2_000_000_000, 5_000_000_000],
  /** GST on top-ups: 18 % (CGST 9 + SGST 9, or IGST 18). */
  gstRateBps: 1800,
  callHoldMinutes: 3,
  callHoldExtendMinutes: 2,
  extendWhenRemainingSeconds: 60,
  graceSeconds: 30,
  staleHoldMs: 2 * 60 * 60_000,
  /** ₹10 lakh per manual adjustment. */
  maxAdjustmentMicros: 1_000_000_000_000,
  /** ₹1 lakh. */
  creditLimitMaxMicros: 100_000_000_000,
  thresholdMaxMicros: 100_000_000_000,
  /** ₹1 crore. */
  budgetMaxMicros: 10_000_000_000_000,
  /** Rate card values above ₹1,000 / minute are refused. */
  rateMaxMicros: 1_000_000_000,
  ledgerExportMaxDays: 366,
  ledgerExportMaxRows: 200_000,
  ledgerPageMax: 100,
  usageMaxDays: 366,
  topupOrdersPerHour: 10,
  orderExpiryMs: 24 * 60 * 60_000,
  stuckCreatingMs: 60 * 60_000,
  alertCooldownMs: 24 * 60 * 60_000,
  rateCardCacheMs: 60_000,
  walletUpdateThrottleMs: 1000,
  invoiceUrlTtlSec: 900,
  providerTimeoutMs: 10_000,
  webhookMaxBytes: 256 * 1024,
} as const;

/** AI agents, knowledge bases and the playground (PHASE_5_PLAN §1, integers only). */
export const AI_LIMITS = {
  agentsPerAccount: 50,
  nameMaxChars: 80,
  descriptionMaxChars: 300,
  personaMaxChars: 8000,
  lineMaxChars: 500,
  toneRulesMax: 10,
  toneRespondMaxChars: 300,
  neverSayMax: 20,
  neverSayMaxChars: 100,
  fallbackMaxChars: 300,
  functionsPerAgent: 10,
  paramsPerFunction: 10,
  functionTimeoutMsMin: 1000,
  functionTimeoutMsMax: 10_000,
  functionTimeoutMsDefault: 6000,
  functionResponseMaxBytes: 65_536,
  functionRedirectsMax: 2,
  toolResultMaxChars: 2000,
  toolResultPreviewChars: 500,
  toolRoundsMax: 3,
  toolCallsPerTurnMax: 10,
  kbPerAccount: 10,
  kbPerAgent: 3,
  sourcesPerKb: 25,
  chunksPerKb: 2000,
  filesPerUpload: 5,
  fileMaxBytes: 10_485_760,
  urlMaxBytes: 2_097_152,
  chunkTargetChars: 3200,
  chunkOverlapChars: 480,
  chunkMaxChars: 4000,
  embedBatch: 64,
  embeddingDims: 1536,
  vectorCacheBytes: 209_715_200,
  historyTurns: 20,
  historyTokens: 12_000,
  messageMaxChars: 2000,
  turnsPerSession: 200,
  playgroundPerMinute: 30,
  kbSourcesPerHour: 20,
  functionTestsPerMinute: 20,
  instructionsMaxChars: 24_000,
  spendCapMaxMicros: 100_000_000_000,
  maxOutputTokensMin: 50,
  maxOutputTokensMax: 1000,
  temperatureTenthsMax: 12,
  playgroundTtlDays: 30,
  toolCallTtlDays: 90,
  deletedAgentPurgeDays: 30,
  chatTimeoutMs: 30_000,
  embedTimeoutMs: 20_000,
  providerRetries: 2,
} as const;
