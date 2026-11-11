/**
 * Recorded-voice / IVR calls through a voice broadcast provider (Cell24x7 Voice API, VAPI).
 * The provider dials and plays the audio itself; we submit numbers in batches and read
 * results. Numbers are 10-digit Indian mobiles. Never log the token or a full number.
 */

/** Statuses Cell24x7 reports per number (`CALLING` and `Submitted` mean the same). */
export const VOICE_API_STATUSES = [
  'PP1',
  'CALLING',
  'Submitted',
  'ANSWERED',
  'NO ANSWER',
  'BUSY',
  'FAILED',
  'STOP',
] as const;
export type VoiceApiStatus = (typeof VOICE_API_STATUSES)[number];

export const VOICE_API_FINAL_STATUSES: ReadonlySet<string> = new Set([
  'ANSWERED',
  'NO ANSWER',
  'BUSY',
  'FAILED',
  'STOP',
]);

/** Minutes Cell24x7 accepts between redials. */
export const VOICE_API_RETRY_INTERVALS = [5, 10, 30, 60, 180, 300] as const;
export type VoiceApiRetryInterval = (typeof VOICE_API_RETRY_INTERVALS)[number];

export type VoiceApiAudio =
  | { kind: 'file'; data: Buffer; filename: string; mime: string }
  | { kind: 'audio_id'; id: number }
  | { kind: 'ivr'; id: number };

export interface VoiceSubmitInput {
  /** `cav-<campaignId>-<batchNo>`: lets support find the batch in the Cell24x7 dashboard. */
  broadcastName: string;
  callerId: string;
  /** 10-digit mobiles (already deduplicated). */
  numbers: string[];
  audio: VoiceApiAudio;
  retries: number;
  retryIntervalMin: VoiceApiRetryInterval;
}

export interface VoiceSubmitResult {
  requestId: string;
  contacts: number;
  creditsDeducted: number | null;
  /** The provider's id of the uploaded audio (reuse with `audio_id`). */
  audioFileId: number | null;
}

export interface VoiceResultRow {
  /** 10 digits. */
  receiver: string;
  status: string;
  durationSec: number;
  retryCount: number;
  dtmf: string | null;
  ivrDisposition: string | null;
}

export interface VoiceDetailsPage {
  rows: VoiceResultRow[];
  hasMore: boolean;
}

export interface VoiceIvr {
  id: number;
  name: string;
  runnable: boolean;
}

/** One number's result, from the webhook or the details poller. */
export interface VoiceResultEvent extends VoiceResultRow {
  requestId: string;
  /**
   * The account whose own Cell24x7 login reported it (its webhook / its poll). Missing =
   * the platform login: rows of accounts on their own token never match then (request ids
   * of two Cell24x7 logins may repeat).
   */
  accountId?: string;
}

export interface VoiceApiClient {
  readonly provider: 'fake' | 'cell24x7';
  submit(input: VoiceSubmitInput): Promise<VoiceSubmitResult>;
  /** One page (1-based) of per-number results, at most 100 rows. */
  details(requestId: string, page: number): Promise<VoiceDetailsPage>;
  ivrs(): Promise<VoiceIvr[]>;
  setWebhook(url: string): Promise<void>;
  getWebhook(): Promise<string | null>;
}

export const VOICE_API_ERROR_CODES = [
  'VOICE_API_REJECTED',
  'VOICE_API_AUTH',
  'VOICE_API_NO_CREDITS',
  'VOICE_API_NOT_FOUND',
  'VOICE_API_UNAVAILABLE',
] as const;
export type VoiceApiErrorCode = (typeof VOICE_API_ERROR_CODES)[number];

/**
 * A failed provider request. `uncertain`: the provider may have accepted it (timeout,
 * 5xx, network) — a submit must never be repeated automatically. The message never
 * carries the token, the request body or a phone number.
 */
/**
 * Why a request got no answer at all (our server could not reach Cell24x7): `timeout`
 * (no reply in time), `connect` (connection refused / timed out — usually a firewall),
 * `dns` (host name not found), `tls` (certificate / HTTPS problem), `network` (other).
 */
export type VoiceNetworkReason = 'timeout' | 'connect' | 'dns' | 'tls' | 'network';

export class VoiceApiError extends Error {
  constructor(
    readonly code: VoiceApiErrorCode,
    readonly status: number,
    readonly uncertain: boolean,
    message: string,
    /** Set when nothing came back from Cell24x7 (status 0). */
    readonly network: VoiceNetworkReason | null = null,
  ) {
    super(message);
    this.name = 'VoiceApiError';
  }
}

/** The kind of network failure behind a `fetch` error (no secrets, no URL). */
export const networkReasonOf = (err: unknown): VoiceNetworkReason => {
  const e = err as { name?: string; cause?: { code?: string; name?: string } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.cause?.code ?? '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return 'dns';
  if (/CONNECT_TIMEOUT|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(code))
    return 'connect';
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(code)) return 'tls';
  return 'network';
};

/** Removes digit runs that could be phone numbers or ids (provider messages, logs). */
export const scrubMessage = (text: string): string => text.replace(/\d{8,}/g, '…').slice(0, 200);

/** `+91XXXXXXXXXX` (a dialable Indian mobile) → 10 digits; anything else → null. */
export const toReceiver10 = (e164: string): string | null => {
  const m = /^\+91([6-9]\d{9})$/.exec(e164);
  return m ? (m[1] as string) : null;
};

/** Started 15-second pulses of `audioSec` (Cell24x7 credits per number). */
export const pulsesFor = (audioSec: number): number => Math.max(1, Math.ceil(audioSec / 15));
