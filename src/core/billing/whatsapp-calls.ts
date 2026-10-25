import { WHATSAPP_BILLING_LIMITS, WHATSAPP_CALL_LIMITS } from '../../config/limits';
import {
  rateCardProblems,
  type CallingRateMarket,
  type CallingRateTier,
} from '../../db/models/whatsapp-rate-card.model';

import {
  cells,
  ceilToPaise,
  isEmpty,
  KNOWN_MARKETS,
  normalizeHeader,
  rateToMicros,
  type CsvParseResult,
} from './whatsapp';

/**
 * WhatsApp call prices (PHASE_12_PROMPT §1 "Pulse math") — pure, integer micros.
 * Meta bills business-initiated calls in 6-second pulses at a per-minute rate for the
 * called number's market (base tier); we sell at that rate + markup (or the account's
 * fixed per-minute price) + the platform fee, each part rounded **up** to the paisa
 * per call. Customer-pays numbers pay the platform fee only. User-initiated calls are
 * free at Meta.
 */
export const PULSES_PER_MINUTE = 60 / WHATSAPP_CALL_LIMITS.pulseSec;

const ceilDiv = (a: number, b: number): number => Math.floor((a + b - 1) / b);

/** `ceil(duration / 6)`; 0 for a call that never connected. */
export const pulsesFor = (durationSec: number): number =>
  durationSec > 0 ? Math.ceil(durationSec / WHATSAPP_CALL_LIMITS.pulseSec) : 0;

/** Meta's price of one pulse (per-minute ÷ 10, rounded up to the micro). */
export const perPulseMicros = (perMinuteMicros: number): number =>
  ceilDiv(Math.max(0, perMinuteMicros), PULSES_PER_MINUTE);

export interface CallPriceInput {
  /** Meta's per-minute rate of the market (micros). */
  perMinuteMicros: number;
  markupBps: number;
  /** Account fixed selling price per minute (wins over Meta's rate + markup). */
  fixedPerMinuteMicros: number | null;
  platformFeePerMinuteMicros: number;
  payer: 'platform' | 'customer';
}

export interface CallPrice {
  pulses: number;
  metaPerPulseMicros: number;
  metaCostMicros: number;
  markupMicros: number;
  platformFeeMicros: number;
  totalMicros: number;
}

export const callPrice = (input: CallPriceInput, durationSec: number): CallPrice => {
  const pulses = pulsesFor(durationSec);
  const metaPerPulse = perPulseMicros(input.perMinuteMicros);
  const fee = ceilToPaise(pulses * perPulseMicros(input.platformFeePerMinuteMicros));
  if (input.payer === 'customer') {
    return {
      pulses,
      metaPerPulseMicros: metaPerPulse,
      metaCostMicros: 0,
      markupMicros: 0,
      platformFeeMicros: fee,
      totalMicros: fee,
    };
  }
  const metaCost = pulses * metaPerPulse;
  const selling =
    input.fixedPerMinuteMicros !== null
      ? ceilToPaise(pulses * perPulseMicros(input.fixedPerMinuteMicros))
      : ceilToPaise(ceilDiv(metaCost * (10_000 + Math.max(0, input.markupBps)), 10_000));
  return {
    pulses,
    metaPerPulseMicros: metaPerPulse,
    metaCostMicros: metaCost,
    markupMicros: selling - metaCost,
    platformFeeMicros: fee,
    totalMicros: selling + fee,
  };
};

/** What `minutes` of call cost at most (the hold at dial / each extension). */
export const callHoldMicros = (input: CallPriceInput, minutes: number): number =>
  callPrice(input, minutes * 60).totalMicros;

/* ── Meta's calling rate card (CSV) ─────────────────────────────────────── */

export type CallingCsvResult = Omit<CsvParseResult, 'markets'> & { markets: CallingRateMarket[] };

const CALLING_COLUMNS: Record<string, 'market' | 'currency' | 'callingCodes' | 'perMinute'> = {
  market: 'market',
  country: 'market',
  marketname: 'market',
  currency: 'currency',
  callingcodes: 'callingCodes',
  callingcode: 'callingCodes',
  countrycodes: 'callingCodes',
  perminute: 'perMinute',
  rateperminute: 'perMinute',
  priceperminute: 'perMinute',
  businessinitiated: 'perMinute',
  businessinitiatedcalls: 'perMinute',
};

/** Volume tier headers: `50000+`, `From 50000 minutes`, `Tier 50000`. */
const tierFrom = (normalized: string): number | null => {
  const m = /^(?:from|tier)?(\d{1,9})(?:\+|plus)?(?:minutes?|mins?)?(?:\+|plus)?$/.exec(normalized);
  return m ? Number(m[1]) : null;
};

/**
 * Meta's INR calling rate card → markets (PHASE_12_PROMPT T12.8): columns `Market`,
 * `Currency`, `Per minute`, optional `Calling codes` and volume tier columns
 * (`50000+` …). Tolerant headers, INR only, errors with their row (1 = header).
 */
export const parseCallingRateCsv = (buffer: Buffer): CallingCsvResult => {
  const errors: CallingCsvResult['errors'] = [];
  if (buffer.length > WHATSAPP_BILLING_LIMITS.csvMaxBytes) {
    return { markets: [], errors: [{ row: 0, message: 'The file is larger than 2 MB' }] };
  }
  const lines = buffer
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l, i) => ({ text: l, row: i + 1 }))
    .filter((l) => l.text.trim());
  const header = lines.shift();
  if (!header) return { markets: [], errors: [{ row: 1, message: 'The file is empty' }] };
  const cols: Partial<Record<'market' | 'currency' | 'callingCodes' | 'perMinute', number>> = {};
  const tierCols: { fromMinutes: number; index: number }[] = [];
  cells(header.text).forEach((name, i) => {
    const normalized = normalizeHeader(name);
    const key = CALLING_COLUMNS[normalized];
    const from = key ? null : tierFrom(normalized);
    if (!key && from === null) {
      errors.push({ row: 1, message: `Unknown column "${name.slice(0, 40)}"` });
      return;
    }
    if (key) {
      if (cols[key] !== undefined)
        errors.push({ row: 1, message: `Column "${name.slice(0, 40)}" twice` });
      cols[key] = i;
      return;
    }
    if (tierCols.some((t) => t.fromMinutes === from))
      errors.push({ row: 1, message: `Column "${name.slice(0, 40)}" twice` });
    tierCols.push({ fromMinutes: from ?? 0, index: i });
  });
  for (const required of ['market', 'perMinute'] as const) {
    if (cols[required] === undefined)
      errors.push({ row: 1, message: `Missing column "${required}"` });
  }
  if (errors.length) return { markets: [], errors };
  tierCols.sort((a, b) => a.fromMinutes - b.fromMinutes);
  const markets: CallingRateMarket[] = [];
  for (const { text, row } of lines) {
    const c = cells(text);
    const at = (k: keyof typeof cols) => (cols[k] === undefined ? undefined : c[cols[k]]);
    const currency = at('currency');
    if (currency && currency.toUpperCase() !== 'INR') {
      errors.push({ row, message: 'Only INR rate cards can be imported' });
      continue;
    }
    const name = (at('market') ?? '').trim();
    if (!name) {
      errors.push({ row, message: 'Missing market name' });
      continue;
    }
    const known = KNOWN_MARKETS[name.toLowerCase()];
    const codesCell = at('callingCodes');
    const codes = isEmpty(codesCell)
      ? (known?.callingCodes ?? null)
      : (codesCell ?? '')
          .split(/[;|/\s]+/)
          .map((x) => x.replace(/\D/g, ''))
          .filter(Boolean);
    if (codes === null) {
      errors.push({ row, message: `Add the calling codes for "${name.slice(0, 40)}"` });
      continue;
    }
    const perMinute = rateToMicros(at('perMinute') ?? '');
    if (perMinute === null) {
      errors.push({
        row,
        message: `Bad per minute rate "${(at('perMinute') ?? '').slice(0, 20)}"`,
      });
      continue;
    }
    const tiers: CallingRateTier[] = [];
    let bad = false;
    for (const t of tierCols) {
      const v = c[t.index];
      if (isEmpty(v)) continue;
      const micros = rateToMicros(v ?? '');
      if (micros === null) {
        errors.push({ row, message: `Bad tier rate "${(v ?? '').slice(0, 20)}"` });
        bad = true;
        continue;
      }
      tiers.push({ fromMinutes: t.fromMinutes, perMinuteMicros: micros });
    }
    if (bad) continue;
    const code =
      known?.code ??
      name
        .toUpperCase()
        .replace(/[^A-Z]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    markets.push({
      market: code.length >= 2 ? code : `M_${code}`,
      label: name.slice(0, 80),
      callingCodes: codes,
      perMinuteMicros: perMinute,
      tiers,
    });
  }
  if (!errors.length) {
    for (const problem of rateCardProblems(markets)) errors.push({ row: 0, message: problem });
  }
  return { markets: errors.length ? [] : markets, errors };
};

export interface CallingRateDiff {
  added: string[];
  removed: string[];
  changed: { market: string; field: string; fromMicros: number | null; toMicros: number | null }[];
}

/** What a new calling card changes against the current one (import preview). */
export const diffCallingCards = (
  current: readonly CallingRateMarket[],
  next: readonly CallingRateMarket[],
): CallingRateDiff => {
  const before = new Map(current.map((m) => [m.market, m]));
  const after = new Map(next.map((m) => [m.market, m]));
  const diff: CallingRateDiff = { added: [], removed: [], changed: [] };
  for (const m of next) {
    const old = before.get(m.market);
    if (!old) {
      diff.added.push(m.market);
      continue;
    }
    if (old.perMinuteMicros !== m.perMinuteMicros)
      diff.changed.push({
        market: m.market,
        field: 'perMinuteMicros',
        fromMicros: old.perMinuteMicros,
        toMicros: m.perMinuteMicros,
      });
    const tiers = (t: CallingRateTier[]) =>
      t.map((x) => `${String(x.fromMinutes)}:${String(x.perMinuteMicros)}`).join(',');
    if (tiers(old.tiers) !== tiers(m.tiers))
      diff.changed.push({ market: m.market, field: 'tiers', fromMicros: null, toMicros: null });
    if (old.callingCodes.join(',') !== m.callingCodes.join(','))
      diff.changed.push({
        market: m.market,
        field: 'callingCodes',
        fromMicros: null,
        toMicros: null,
      });
  }
  for (const m of current) if (!after.has(m.market)) diff.removed.push(m.market);
  return diff;
};
