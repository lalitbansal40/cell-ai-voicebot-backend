import { z } from 'zod';

import {
  scrubMessage,
  VoiceApiError,
  type VoiceApiClient,
  type VoiceDetailsPage,
  type VoiceIvr,
  type VoiceResultRow,
  type VoiceSubmitInput,
  type VoiceSubmitResult,
} from './types';

/**
 * Cell24x7 Voice API (partner endpoints, PDF of 5 Nov 2026): `POST /submit` (multipart),
 * `GET /details`, `GET /ivrs`, `POST|GET /webhook`. Bearer token; server only.
 * The PDF does not spell out every response field, so lists are read leniently.
 */

export interface Cell24x7Config {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Per request; submits with a file get `uploadTimeoutMs`. */
  timeoutMs?: number;
  uploadTimeoutMs?: number;
}

const Envelope = z.object({
  success: z.boolean().optional(),
  data: z.unknown().optional(),
  message: z.string().optional(),
  code: z.string().optional(),
});

const SubmitData = z.object({
  request_id: z.string().min(1).max(100),
  contacts: z.coerce.number().int().min(0).optional(),
  credits_deducted: z.coerce.number().min(0).nullable().optional(),
  audio_file_id: z.coerce.number().int().positive().nullable().optional(),
});

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Last 10 digits of whatever the provider calls the number. */
const receiverOf = (row: Record<string, unknown>): string | null => {
  const raw =
    str(row.receiver) ??
    str(row.number) ??
    str(row.mobile) ??
    str(row.mobile_number) ??
    str(row.phone) ??
    str(row.msisdn);
  const digits = raw?.replace(/\D/g, '') ?? '';
  return digits.length >= 10 ? digits.slice(-10) : null;
};

/** One `/details` row (field names vary; status is required). */
export const parseResultRow = (value: unknown): VoiceResultRow | null => {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const receiver = receiverOf(row);
  const status = (str(row.status) ?? str(row.call_status))?.trim().toUpperCase();
  if (!receiver || !status) return null;
  const ivr = (row.ivr && typeof row.ivr === 'object' ? row.ivr : {}) as Record<string, unknown>;
  const dtmf = str(row.dtmf_pressed) ?? str(row.digits_pressed) ?? str(ivr.digits_pressed) ?? null;
  return {
    receiver,
    status: status === 'SUBMITTED' ? 'Submitted' : status,
    durationSec: Math.round(num(row.duration ?? row.call_duration ?? row.duration_sec)),
    retryCount: Math.round(num(row.retry_count ?? row.retries ?? row.retry)),
    dtmf: dtmf ? dtmf.slice(0, 32) : null,
    ivrDisposition: str(ivr.disposition)?.slice(0, 60) ?? null,
  };
};

const listOf = (data: unknown): unknown[] => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    for (const key of ['rows', 'items', 'records', 'details', 'data', 'list']) {
      if (Array.isArray(d[key])) return d[key];
    }
  }
  return [];
};

const LIMIT = 100;

export class Cell24x7VoiceClient implements VoiceApiClient {
  readonly provider = 'cell24x7' as const;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: Cell24x7Config) {
    this.fetchFn = config.fetch ?? fetch;
  }

  private url(path: string, query: Record<string, string | number> = {}): URL {
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, '')}${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    return url;
  }

  private async request(
    op: string,
    url: URL,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${this.config.token}`,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new VoiceApiError('VOICE_API_UNAVAILABLE', 0, true, `${op}: no answer`);
    }
    const text = await res.text().catch(() => '');
    let body: z.infer<typeof Envelope> = {};
    try {
      const parsed = Envelope.safeParse(text ? JSON.parse(text) : {});
      if (parsed.success) body = parsed.data;
    } catch {
      // not JSON (proxy error page): status decides below
    }
    if (res.ok && body.success !== false) return body.data;
    const message = scrubMessage(`${op}: ${body.message ?? `HTTP ${String(res.status)}`}`);
    if (res.status === 401 || res.status === 403)
      throw new VoiceApiError('VOICE_API_AUTH', res.status, false, message);
    if (res.status === 402) throw new VoiceApiError('VOICE_API_NO_CREDITS', 402, false, message);
    if (res.status === 404) throw new VoiceApiError('VOICE_API_NOT_FOUND', 404, false, message);
    if (res.status >= 400 && res.status < 500)
      throw new VoiceApiError('VOICE_API_REJECTED', res.status, false, message);
    throw new VoiceApiError('VOICE_API_UNAVAILABLE', res.status, true, message);
  }

  async submit(input: VoiceSubmitInput): Promise<VoiceSubmitResult> {
    const form = new FormData();
    form.set('broadcast_name', input.broadcastName.slice(0, 100));
    form.set('caller_id', input.callerId);
    form.set(
      'csv_file',
      new Blob([`number\n${input.numbers.join('\n')}\n`], { type: 'text/csv' }),
      'numbers.csv',
    );
    if (input.audio.kind === 'file') {
      form.set(
        'audio_file',
        new Blob([new Uint8Array(input.audio.data)], { type: input.audio.mime }),
        input.audio.filename,
      );
    } else if (input.audio.kind === 'audio_id') {
      form.set('audio_file_id', String(input.audio.id));
    } else {
      form.set('ivr_id', String(input.audio.id));
    }
    form.set('retries', String(input.retries));
    if (input.retries > 0) form.set('retry_interval', String(input.retryIntervalMin));
    const data = await this.request(
      'submit',
      this.url('/submit'),
      { method: 'POST', body: form },
      input.audio.kind === 'file'
        ? (this.config.uploadTimeoutMs ?? 60_000)
        : (this.config.timeoutMs ?? 15_000),
    );
    const parsed = SubmitData.safeParse(data);
    // accepted (2xx) but unreadable: the campaign exists there — never resubmit
    if (!parsed.success)
      throw new VoiceApiError('VOICE_API_UNAVAILABLE', 200, true, 'submit: unreadable answer');
    return {
      requestId: parsed.data.request_id,
      contacts: parsed.data.contacts ?? input.numbers.length,
      creditsDeducted: parsed.data.credits_deducted ?? null,
      audioFileId: parsed.data.audio_file_id ?? null,
    };
  }

  async details(requestId: string, page: number): Promise<VoiceDetailsPage> {
    const data = await this.request(
      'details',
      this.url('/details', { request_id: requestId, page, limit: LIMIT }),
      { method: 'GET' },
      this.config.timeoutMs ?? 15_000,
    );
    const raw = listOf(data);
    const rows = raw.map(parseResultRow).filter((r): r is VoiceResultRow => r !== null);
    return { rows, hasMore: raw.length >= LIMIT };
  }

  async ivrs(): Promise<VoiceIvr[]> {
    const data = await this.request(
      'ivrs',
      this.url('/ivrs'),
      { method: 'GET' },
      this.config.timeoutMs ?? 15_000,
    );
    return listOf(data).flatMap((v) => {
      if (!v || typeof v !== 'object') return [];
      const r = v as Record<string, unknown>;
      const id = num(r.id ?? r.ivr_id);
      if (!Number.isInteger(id) || id <= 0) return [];
      return [
        {
          id,
          name: (str(r.name) ?? str(r.ivr_name) ?? `IVR ${String(id)}`).slice(0, 100),
          runnable: r.runnable === true || r.runnable === 1 || r.runnable === 'true',
        },
      ];
    });
  }

  async setWebhook(url: string): Promise<void> {
    await this.request(
      'webhook',
      this.url('/webhook'),
      {
        method: 'POST',
        body: JSON.stringify({ url }),
        headers: { 'content-type': 'application/json' },
      },
      this.config.timeoutMs ?? 15_000,
    );
  }

  async getWebhook(): Promise<string | null> {
    const data = await this.request(
      'webhook',
      this.url('/webhook'),
      { method: 'GET' },
      this.config.timeoutMs ?? 15_000,
    );
    if (typeof data === 'string') return data || null;
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      return str(d.url) ?? str(d.webhook_url) ?? null;
    }
    return null;
  }
}
