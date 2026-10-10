import type { FlowVarType } from '../../db/models/flow.model';
import { formatInr } from '../../shared/money';
import { createTemplate } from '../templating';

/** Value types a template / condition can meet (contact types + flow types). */
export type ValueType = FlowVarType | 'currency' | 'phone' | 'built_in';

export type VariableSource = 'contact' | 'flow' | 'system';

export interface VariableEntry {
  name: string;
  label: string;
  type: ValueType;
  source: VariableSource;
  /** Contact and system variables can't be targets of `saveAs` / `set_variable`. */
  readOnly: boolean;
}

/** Engine-set variables (read-only; PHASE_6_PLAN §1c). */
export const SYSTEM_VARIABLES: readonly Omit<VariableEntry, 'source' | 'readOnly'>[] = [
  { name: 'company', label: 'Company name', type: 'text' },
  { name: 'today', label: 'Today (account timezone)', type: 'date' },
  { name: 'now_time', label: 'Time now (HH:mm)', type: 'text' },
  { name: 'last_dtmf', label: 'Last keys pressed', type: 'text' },
  { name: 'last_speech', label: 'Last thing the customer said', type: 'text' },
  { name: 'last_intent', label: 'Last matched intent', type: 'text' },
  { name: 'last_api_status', label: 'Last API status code', type: 'number' },
  { name: 'disposition', label: 'Disposition', type: 'text' },
  { name: 'promise_date', label: 'Promise-to-pay date', type: 'date' },
  { name: 'promise_amount', label: 'Promise-to-pay amount', type: 'currency' },
  { name: 'callback_date', label: 'Callback date', type: 'date' },
  { name: 'callback_time', label: 'Callback time', type: 'text' },
  { name: 'transfer_result', label: 'Transfer result', type: 'text' },
];
export const SYSTEM_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  SYSTEM_VARIABLES.map((v) => v.name),
);

export interface ContactVariableInfo {
  name: string;
  label: string;
  type: 'text' | 'number' | 'currency' | 'date' | 'phone' | 'built_in';
}

export interface FlowVariableInfo {
  name: string;
  type: FlowVarType;
  label?: string;
}

/** Picker / validator catalogue: contact fields, then flow variables, then system ones. */
export const buildVariableCatalog = (input: {
  contactVars: readonly ContactVariableInfo[];
  flowVars: readonly FlowVariableInfo[];
}): VariableEntry[] => [
  ...input.contactVars.map((v) => ({ ...v, source: 'contact' as const, readOnly: true })),
  ...input.flowVars.map((v) => ({
    name: v.name,
    label: v.label ?? v.name,
    type: v.type,
    source: 'flow' as const,
    readOnly: false,
  })),
  ...SYSTEM_VARIABLES.map((v) => ({ ...v, source: 'system' as const, readOnly: true })),
];

// ── Typed values ────────────────────────────────────────────────────────────

export type RunValue = string | number | boolean | null;

export class CoercionError extends Error {
  constructor(
    readonly type: FlowVarType,
    readonly raw: unknown,
  ) {
    super(`Not a valid ${type}`);
    this.name = 'CoercionError';
  }
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `YYYY-MM-DD` that is a real calendar date (`2026-02-30` refused). */
export const isYmd = (value: string): boolean => {
  const m = YMD.exec(value);
  if (!m) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(d.getTime()) &&
    d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() + 1 === Number(m[2]) &&
    d.getUTCDate() === Number(m[3])
  );
};

const NUMBER = /^-?\d+(\.\d+)?$/;
const TRUE = new Set(['true', 'yes', 'haan', 'ha', 'han', '1']);
const FALSE = new Set(['false', 'no', 'nahi', 'nahin', '0']);

/** Raw value (rendered template, API response field) → typed value of a flow variable. */
export const coerce = (type: FlowVarType, raw: unknown): RunValue => {
  if (raw === null || raw === undefined) return null;
  const textValue =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number' || typeof raw === 'boolean'
        ? String(raw)
        : null;
  if (textValue === null) throw new CoercionError(type, raw);
  if (textValue === '') return null;
  switch (type) {
    case 'text':
      return textValue;
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
      if (NUMBER.test(textValue)) return Number(textValue);
      throw new CoercionError(type, raw);
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const lower = textValue.toLowerCase();
      if (TRUE.has(lower)) return true;
      if (FALSE.has(lower)) return false;
      throw new CoercionError(type, raw);
    }
    case 'date':
      if (isYmd(textValue)) return textValue;
      throw new CoercionError(type, raw);
  }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `2026-10-11` → `11 Oct 2026` (other text unchanged). */
export const readableDate = (ymd: string): string => {
  const m = YMD.exec(ymd);
  return m && isYmd(ymd) ? `${m[3] ?? ''} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1] ?? ''}` : ymd;
};

/** Typed value → what is spoken / shown (₹, readable dates, haan / nahi). */
export const displayValue = (
  type: ValueType,
  value: RunValue,
  language: 'hi' | 'en' | 'hinglish',
): string => {
  if (value === null || value === '') return '';
  if (typeof value === 'boolean') {
    if (language === 'en') return value ? 'yes' : 'no';
    return value ? 'haan' : 'nahi';
  }
  if (typeof value === 'number') {
    if (type === 'currency') return formatInr(value);
    return value.toLocaleString('en-IN');
  }
  if (type === 'date') return readableDate(value);
  return value;
};

// ── Flow templates ──────────────────────────────────────────────────────────

/** What a flow template sees: display strings by name + server-only contact facts. */
export interface FlowTemplateContext {
  values: Readonly<Record<string, string>>;
  /** Only filled for `api_request` (full phone / external id never reach texts). */
  contact?: { phone: string | null; external_id: string | null };
}

export const SERVER_ONLY_TOKENS = ['contact.phone', 'contact.external_id'] as const;

/** `{{name}}`, `{{amount}}` … + `{{contact.phone}}` / `{{contact.external_id}}` (API node only). */
export const flowTemplate = createTemplate<FlowTemplateContext>({
  token: 'contact\\.phone|contact\\.external_id|[a-z][a-z0-9_]{0,39}',
  resolve: (token, ctx) => {
    if (token === 'contact.phone') return ctx.contact?.phone ?? undefined;
    if (token === 'contact.external_id') return ctx.contact?.external_id ?? undefined;
    return Object.hasOwn(ctx.values, token) ? ctx.values[token] : undefined;
  },
});
