import { WHATSAPP_BILLING_LIMITS } from '../../config/limits';
import {
  OTHER_MARKET,
  rateCardProblems,
  type RateCardMarket,
} from '../../db/models/whatsapp-rate-card.model';
import { BPS_SCALE, ceilDiv, MONEY_SCALE, PAISA_MICROS } from '../../shared/money';

/**
 * WhatsApp message prices (PHASE_11_PLAN §1f) — pure integer math, no I/O. Meta's
 * rate for the recipient's market × category, our markup on top (rounded **up** to
 * the paisa) or the account's fixed price, plus the platform fee.
 */

export const PRICE_CATEGORIES = [
  'marketing',
  'utility',
  'authentication',
  'authentication_international',
  'service',
] as const;
export type PriceCategory = (typeof PRICE_CATEGORIES)[number];

/** The market of an E.164 number: the longest matching calling code, else `OTHER`. */
export const marketFor = (
  phoneE164: string,
  markets: readonly RateCardMarket[],
): RateCardMarket => {
  const digits = phoneE164.replace(/\D/g, '');
  let best: { market: RateCardMarket; length: number } | null = null;
  for (const m of markets) {
    for (const code of m.callingCodes) {
      if (digits.startsWith(code) && (!best || code.length > best.length)) {
        best = { market: m, length: code.length };
      }
    }
  }
  const other = markets.find((m) => m.market === OTHER_MARKET);
  const found = best?.market ?? other;
  if (!found) throw new Error('rate card has no OTHER market');
  return found;
};

/** Meta's list rate (first tier) for a category; international authentication falls back to the local rate. */
export const metaRate = (market: RateCardMarket, category: PriceCategory): number => {
  switch (category) {
    case 'marketing':
      return market.marketingMicros;
    case 'utility':
      return market.utilityMicros;
    case 'authentication':
      return market.authenticationMicros;
    case 'authentication_international':
      return market.authenticationInternationalMicros ?? market.authenticationMicros;
    case 'service':
      return market.serviceMicros;
  }
};

/** Rounds micros **up** to a whole paisa. */
export const ceilToPaise = (micros: number): number => ceilDiv(micros, PAISA_MICROS) * PAISA_MICROS;

export interface SellingPriceInput {
  metaRateMicros: number;
  markupBps: number;
  /** Account fixed price for the category (wins over the markup). */
  fixedPriceMicros?: number | null;
  platformFeeMicros: number;
  /** `customer` pays Meta directly: we charge the platform fee only. */
  payer: 'platform' | 'customer';
}

export interface SellingPrice {
  priceMicros: number;
  /** What Meta charges us (0 when the customer pays Meta). */
  metaCostMicros: number;
  markupMicros: number;
  platformFeeMicros: number;
}

export const sellingPrice = (input: SellingPriceInput): SellingPrice => {
  const fee = Math.max(0, input.platformFeeMicros);
  if (input.payer === 'customer') {
    return { priceMicros: fee, metaCostMicros: 0, markupMicros: 0, platformFeeMicros: fee };
  }
  const rate = Math.max(0, input.metaRateMicros);
  const base =
    input.fixedPriceMicros !== undefined && input.fixedPriceMicros !== null
      ? ceilToPaise(Math.max(0, input.fixedPriceMicros))
      : ceilToPaise(ceilDiv(rate * (BPS_SCALE + Math.max(0, input.markupBps)), BPS_SCALE));
  return {
    priceMicros: base + fee,
    metaCostMicros: rate,
    markupMicros: Math.max(0, base - rate),
    platformFeeMicros: fee,
  };
};

/* ── Meta's published rate card (CSV) ─────────────────────────────────── */

/** Our market codes for Meta's market names (Meta's CSV has no calling codes). */
export const KNOWN_MARKETS: Record<string, { code: string; callingCodes: string[] }> = {
  india: { code: 'IN', callingCodes: ['91'] },
  indonesia: { code: 'ID', callingCodes: ['62'] },
  pakistan: { code: 'PK', callingCodes: ['92'] },
  'united arab emirates': { code: 'AE', callingCodes: ['971'] },
  'saudi arabia': { code: 'SA', callingCodes: ['966'] },
  'united kingdom': { code: 'GB', callingCodes: ['44'] },
  'north america': { code: 'NORTH_AMERICA', callingCodes: ['1'] },
  brazil: { code: 'BR', callingCodes: ['55'] },
  mexico: { code: 'MX', callingCodes: ['52'] },
  germany: { code: 'DE', callingCodes: ['49'] },
  france: { code: 'FR', callingCodes: ['33'] },
  italy: { code: 'IT', callingCodes: ['39'] },
  spain: { code: 'ES', callingCodes: ['34'] },
  netherlands: { code: 'NL', callingCodes: ['31'] },
  turkey: { code: 'TR', callingCodes: ['90'] },
  egypt: { code: 'EG', callingCodes: ['20'] },
  nigeria: { code: 'NG', callingCodes: ['234'] },
  'south africa': { code: 'ZA', callingCodes: ['27'] },
  israel: { code: 'IL', callingCodes: ['972'] },
  malaysia: { code: 'MY', callingCodes: ['60'] },
  argentina: { code: 'AR', callingCodes: ['54'] },
  chile: { code: 'CL', callingCodes: ['56'] },
  colombia: { code: 'CO', callingCodes: ['57'] },
  peru: { code: 'PE', callingCodes: ['51'] },
  russia: { code: 'RU', callingCodes: ['7'] },
  other: { code: OTHER_MARKET, callingCodes: [] },
  'rest of world': { code: OTHER_MARKET, callingCodes: [] },
};

/** Header names we accept (lower case, spaces / dashes / underscores ignored). */
const COLUMNS: Record<string, keyof ParsedColumns> = {
  market: 'market',
  country: 'market',
  marketname: 'market',
  currency: 'currency',
  callingcodes: 'callingCodes',
  callingcode: 'callingCodes',
  countrycodes: 'callingCodes',
  marketing: 'marketing',
  utility: 'utility',
  authentication: 'authentication',
  authenticationinternational: 'authenticationInternational',
  service: 'service',
};

interface ParsedColumns {
  market: number;
  currency: number;
  callingCodes: number;
  marketing: number;
  utility: number;
  authentication: number;
  authenticationInternational: number;
  service: number;
}

const normalizeHeader = (h: string) =>
  h
    .toLowerCase()
    .replace(/[\s_\-()]/g, '')
    .replace(/inr$/, '');

/** One CSV line → cells (quotes with `""`; no multi-line cells in Meta's file). */
const cells = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
};

/** `"0.8631"` / `"₹0.8631"` / `"INR 1.15"` → micros (≤ 6 decimals, string math only). */
export const rateToMicros = (text: string): number | null => {
  const t = text.replace(/₹|inr/gi, '').trim();
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(t)) return null;
  const [whole = '0', fraction = ''] = t.split('.');
  return Number(whole) * MONEY_SCALE + Number(fraction.padEnd(6, '0'));
};

const isEmpty = (v: string | undefined) => !v || /^(-|n\/?a|none)$/i.test(v.trim());

export interface CsvParseResult {
  markets: RateCardMarket[];
  errors: { row: number; message: string }[];
}

/**
 * Meta's INR rate card CSV → markets. Tolerant header names; INR only; ≤ 300 markets;
 * duplicate / unknown columns and bad cells are errors with their row number (1 = header).
 */
export const parseMetaRateCsv = (buffer: Buffer): CsvParseResult => {
  const errors: CsvParseResult['errors'] = [];
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
  const cols: Partial<ParsedColumns> = {};
  cells(header.text).forEach((name, i) => {
    const key = COLUMNS[normalizeHeader(name)];
    if (!key) {
      errors.push({ row: 1, message: `Unknown column "${name.slice(0, 40)}"` });
      return;
    }
    if (cols[key] !== undefined)
      errors.push({ row: 1, message: `Column "${name.slice(0, 40)}" twice` });
    cols[key] = i;
  });
  for (const required of ['market', 'marketing', 'utility', 'authentication', 'service'] as const) {
    if (cols[required] === undefined)
      errors.push({ row: 1, message: `Missing column "${required}"` });
  }
  if (errors.length) return { markets: [], errors };
  const markets: RateCardMarket[] = [];
  for (const { text, row } of lines) {
    const c = cells(text);
    const at = (k: keyof ParsedColumns) => (cols[k] === undefined ? undefined : c[cols[k]]);
    const currency = at('currency');
    if (currency && currency.toUpperCase() !== 'INR') {
      errors.push({ row, message: 'Only INR rate cards can be imported' });
      continue;
    }
    const name = (at('market') ?? '').trim();
    const known = KNOWN_MARKETS[name.toLowerCase()];
    const codesCell = at('callingCodes');
    const codes = isEmpty(codesCell)
      ? (known?.callingCodes ?? null)
      : (codesCell ?? '')
          .split(/[;|/\s]+/)
          .map((x) => x.replace(/\D/g, ''))
          .filter(Boolean);
    if (!name) {
      errors.push({ row, message: 'Missing market name' });
      continue;
    }
    if (codes === null) {
      errors.push({ row, message: `Add the calling codes for "${name.slice(0, 40)}"` });
      continue;
    }
    const code =
      known?.code ??
      name
        .toUpperCase()
        .replace(/[^A-Z]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);
    const rate = (k: keyof ParsedColumns, optional = false): number | null | undefined => {
      const v = at(k);
      if (optional && isEmpty(v)) return null;
      const micros = rateToMicros(v ?? '');
      if (micros === null)
        errors.push({ row, message: `Bad ${k} rate "${(v ?? '').slice(0, 20)}"` });
      return micros ?? undefined;
    };
    const marketing = rate('marketing');
    const utility = rate('utility');
    const authentication = rate('authentication');
    const service = rate('service');
    const international = rate('authenticationInternational', true);
    if (
      marketing === undefined ||
      utility === undefined ||
      authentication === undefined ||
      service === undefined ||
      international === undefined
    )
      continue;
    markets.push({
      market: code.length >= 2 ? code : `M_${code}`,
      label: name.slice(0, 80),
      callingCodes: codes,
      marketingMicros: marketing ?? 0,
      utilityMicros: utility ?? 0,
      authenticationMicros: authentication ?? 0,
      authenticationInternationalMicros: international ?? null,
      serviceMicros: service ?? 0,
      utilityTiers: [],
      authenticationTiers: [],
    });
  }
  if (!errors.length) {
    for (const problem of rateCardProblems(markets)) errors.push({ row: 0, message: problem });
  }
  return { markets: errors.length ? [] : markets, errors };
};

export interface RateCardDiff {
  added: string[];
  removed: string[];
  changed: { market: string; field: string; fromMicros: number | null; toMicros: number | null }[];
}

const RATE_FIELDS = [
  'marketingMicros',
  'utilityMicros',
  'authenticationMicros',
  'authenticationInternationalMicros',
  'serviceMicros',
] as const;

/** What a new card changes against the current one (import preview). */
export const diffRateCards = (
  current: readonly RateCardMarket[],
  next: readonly RateCardMarket[],
): RateCardDiff => {
  const before = new Map(current.map((m) => [m.market, m]));
  const after = new Map(next.map((m) => [m.market, m]));
  const diff: RateCardDiff = { added: [], removed: [], changed: [] };
  for (const m of next) {
    const old = before.get(m.market);
    if (!old) {
      diff.added.push(m.market);
      continue;
    }
    for (const f of RATE_FIELDS) {
      if (old[f] !== m[f]) {
        diff.changed.push({ market: m.market, field: f, fromMicros: old[f], toMicros: m[f] });
      }
    }
    if (old.callingCodes.join(',') !== m.callingCodes.join(',')) {
      diff.changed.push({
        market: m.market,
        field: 'callingCodes',
        fromMicros: null,
        toMicros: null,
      });
    }
  }
  for (const m of current) if (!after.has(m.market)) diff.removed.push(m.market);
  return diff;
};
