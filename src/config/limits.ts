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

/** Call flows, the flow engine, the simulator and flow audio (PHASE_6_PLAN §1, integers only). */
export const FLOW_LIMITS = {
  flowsPerAccount: 100,
  nameMaxChars: 80,
  descriptionMaxChars: 300,
  nodesMax: 150,
  edgesMax: 300,
  /** Canonical graph JSON, bytes. */
  graphMaxBytes: 524_288,
  labelMaxChars: 60,
  idMaxChars: 40,
  positionAbsMax: 100_000,
  variablesMax: 50,
  speakTextMaxChars: 1000,
  /** Longer speak texts get a warning (long for a phone call). */
  speakLongWarnChars: 400,
  promptTextMaxChars: 1000,
  shortTextMaxChars: 300,
  fallbackTextMaxChars: 500,
  dtmfKeysMax: 12,
  digitsMax: 20,
  gatherTimeoutSecMin: 3,
  gatherTimeoutSecMax: 30,
  dtmfTimeoutSecDefault: 7,
  speechTimeoutSecDefault: 8,
  gatherRetriesMax: 5,
  gatherRetriesDefault: 2,
  intentsMax: 10,
  keywordsPerIntent: 20,
  keywordMaxChars: 60,
  aiGoalMaxChars: 1000,
  aiPassVariablesMax: 10,
  aiMaxTurnsMax: 50,
  aiMaxTurnsDefault: 20,
  apiHeadersMax: 10,
  apiSaveResponseMax: 10,
  routerRulesMax: 10,
  ruleConditionsMax: 5,
  assignmentsMax: 10,
  transferTimeoutSecMin: 10,
  transferTimeoutSecMax: 60,
  transferTimeoutSecDefault: 30,
  smsMaxChars: 500,
  smsSinglePartChars: 160,
  waTemplateParamsMax: 10,
  waitSecMax: 60,
  flowMaxDurationSecMin: 60,
  flowMaxDurationSecMax: 3600,
  flowMaxDurationSecDefault: 900,
  stepsPerRunMax: 300,
  visitsPerNodeMax: 25,
  /** Nodes run between two customer inputs (non-waiting chain). */
  autoStepsMax: 50,
  traceRowsMax: 600,
  transcriptRowsMax: 400,
  inputsPerRunMax: 200,
  messagesPerRunMax: 10,
  simulatorInputsPerMinute: 60,
  simulatorTtlDays: 30,
  simulationsListed: 20,
  /** 5 MB. */
  audioMaxBytes: 5_242_880,
  audioMaxMs: 120_000,
  audiosPerAccount: 200,
  audioUploadsPerHour: 20,
  audioUrlTtlSec: 600,
  versionNotesMaxChars: 200,
  importMaxBytes: 524_288,
  deletedFlowPurgeDays: 30,
} as const;

/** Phase 7 voice calls (PHASE_7_PLAN §1l, PHASE_7_PROMPT §1). */
export const CALL_LIMITS = {
  frameMs: 20,
  /** Web call leg: PCM16 mono 24 kHz. */
  webSampleRate: 24_000,
  /** 20 ms × 24 kHz × 2 bytes. */
  webFrameBytes: 960,
  /** SIP leg (Phase 13): G.711 μ-law 8 kHz. */
  phoneSampleRate: 8_000,
  /** Recordings: stereo PCM16 at this rate. */
  recordingSampleRate: 8_000,
  concurrentPerAccount: 3,
  concurrentPerProcess: 20,
  webCallsPerMinutePerUser: 10,
  readyTimeoutSec: 15,
  dropGraceSec: 5,
  inboundIdleSec: 30,
  maxCallSecHard: 3_600,
  framesPerSecMax: 60,
  framesBurst: 100,
  controlMaxBytes: 16_384,
  sayTextMaxChars: 500,
  ttsTextMaxChars: 1_000,
  ttsCacheUnusedDays: 30,
  functionCallsPerTurn: 5,
  hangupPlaybackWaitSec: 10,
  shutdownLineMaxSec: 5,
  /** Extend the wallet hold when it covers less than this. */
  holdLowWaterSec: 60,
  holdCheckEverySec: 5,
  heartbeatSec: 10,
  registryTtlSec: 30,
  staleHeartbeatSec: 60,
  /** Queued calls nobody connected to are canceled after this. */
  queuedStaleMin: 15,
  playbackAheadMs: 200,
  backpressureBytes: 65_536,
  digitsInterDigitSec: 3,
  transferAnswerSec: 60,
  latencySamplesMax: 200,
  recordingNoticeMaxChars: 200,
  recordingUrlTtlSec: 300,
  recordingUploadAttempts: 3,
  eventsListedMax: 2_000,
  transcriptListedMax: 2_000,
  callsPageMax: 100,
} as const;

/** Locked fixed lines spoken by the runtime (PHASE_7_PROMPT §1 "Fixed lines"). */
export const CALL_LINES = {
  recordingNotice: 'Yeh call quality ke liye record ki ja rahi hai.',
  walletEmpty: 'Aapka balance khatam ho gaya hai, call yahin samaapt ki ja rahi hai.',
  technical: 'Maaf kijiye, takneeki samasya ki wajah se call samaapt ho rahi hai.',
  silenceHi: 'Hello? Kya aap sun rahe hain?',
  silenceEn: 'Hello? Are you still there?',
} as const;

/** Phase 8 campaigns (PHASE_8_PLAN §1l, PHASE_8_PROMPT §1 "Limits"). */
export const CAMPAIGN_LIMITS = {
  nameMaxChars: 120,
  maxContacts: 50_000,
  maxActivePerAccount: 10,
  maxPickedContacts: 1_000,
  snapshotBatch: 1_000,
  scheduleAheadDays: 90,
  maxAttemptsMin: 1,
  maxAttemptsMax: 5,
  intervalMinMinutes: 15,
  intervalMaxMinutes: 1_440,
  callbackMaxDaysMax: 14,
  promiseDaysAfterMax: 14,
  dialsPerMinuteMax: 120,
  tickMs: 2_000,
  wakeDebounceMs: 100,
  claimLeaseMs: 120_000,
  slotLeaseMs: 30_000,
  windowEndBufferMin: 5,
  failuresToPause: 10,
  progressThrottleMs: 1_000,
  exportMaxRows: 100_000,
  deletedPurgeDays: 30,
  dryRunSpeeds: [1, 5, 10, 20],
  previewSampleRows: 20,
  etaWindowMinutes: 10,
  historyMax: 100,
  /** Average answered call when the flow has no history yet. */
  defaultAvgDurationSec: 60,
  estimateSampleCalls: 100,
  /** TRAI: commercial calls 09:00–21:00 (every live campaign). */
  trafficHardWindow: { start: '09:00', end: '21:00' },
  /** RBI recovery conduct: 08:00–19:00 (live campaigns with a recovery agent). */
  recoveryHardWindow: { start: '08:00', end: '19:00' },
  defaults: {
    maxAttempts: 3,
    intervalMinutes: 60,
    retryOn: ['no_answer', 'busy', 'failed'],
    concurrency: 5,
    dialsPerMinute: 30,
    priority: 'normal',
    callbackMaxDays: 7,
    promiseDaysAfter: 1,
    dryRunSpeed: 10,
  },
} as const;

/** Superadmin-set dialing limits per account (PHASE_8_PROMPT T8.6). */
export const ACCOUNT_LIMIT_RANGES = {
  maxConcurrentCalls: { min: 1, max: 200 },
  dialsPerMinute: { min: 1, max: 600 },
} as const;

/** Per-contact call caps an owner / admin may set (PHASE_8_PROMPT T8.6). */
export const CALL_CAP_RANGES = {
  perDay: { min: 1, max: 10 },
  perWeek: { min: 1, max: 50 },
  minGapMinutes: { min: 0, max: 1_440 },
} as const;
