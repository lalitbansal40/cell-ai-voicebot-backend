/**
 * Money helpers (ADR 0016): integer micro-units only — ₹1 = 1,000,000 micros,
 * percentages as basis points (1 % = 100 bps). No floats anywhere in a money path.
 */
export const MONEY_SCALE = 1_000_000;
/** 1 paisa in micros. */
export const PAISA_MICROS = 10_000;
/** 100 % in basis points. */
export const BPS_SCALE = 10_000;

/** Throws unless `value` is a safe integer (optionally ≥ 0). */
export const assertMicros = (value: number, { allowNegative = false } = {}): number => {
  if (!Number.isSafeInteger(value)) throw new RangeError(`Not a safe integer amount: ${value}`);
  if (!allowNegative && value < 0) throw new RangeError(`Negative amount: ${value}`);
  return value;
};

export const isMicros = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

/** `ceil(a / b)` for non-negative integers. */
export const ceilDiv = (a: number, b: number): number => {
  if (b <= 0) throw new RangeError('Divisor must be positive');
  if (a <= 0) return 0;
  return Math.floor((a + b - 1) / b);
};

/** `round(a / b)` half up, for non-negative integers. */
export const roundDiv = (a: number, b: number): number => {
  if (b <= 0) throw new RangeError('Divisor must be positive');
  if (a < 0) return -roundDiv(-a, b);
  return Math.floor((2 * a + b) / (2 * b));
};

/** `micros × bps / 10,000`, rounded half up to whole micros. */
export const mulBps = (micros: number, bps: number): number =>
  roundDiv(assertMicros(micros, { allowNegative: true }) * bps, BPS_SCALE);

/** Micros → paise; throws if the amount is not a whole number of paise. */
export const microsToPaise = (micros: number): number => {
  assertMicros(micros, { allowNegative: true });
  if (micros % PAISA_MICROS !== 0) throw new RangeError(`Not a whole paisa: ${micros}`);
  return micros / PAISA_MICROS;
};

export const paiseToMicros = (paise: number): number => {
  if (!Number.isSafeInteger(paise)) throw new RangeError(`Not a safe integer paise: ${paise}`);
  return paise * PAISA_MICROS;
};

/** Rounds micros to the nearest whole paisa (half up). */
export const roundToPaise = (micros: number): number =>
  roundDiv(micros, PAISA_MICROS) * PAISA_MICROS;

const RUPEES = /^(\d{1,3}(,\d{2})*,\d{3}|\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/;

/**
 * `"1,25,000.50"` → micros. Indian or western grouping, at most 2 decimals,
 * no sign. Returns `null` for anything else.
 */
export const rupeesToMicros = (input: string): number | null => {
  const text = input.trim().replace(/^₹\s*/, '');
  if (!RUPEES.test(text)) return null;
  const [whole = '0', fraction = ''] = text.replace(/,/g, '').split('.');
  const micros = Number(whole) * MONEY_SCALE + Number(fraction.padEnd(2, '0')) * PAISA_MICROS;
  return Number.isSafeInteger(micros) ? micros : null;
};

const groupIndian = (digits: string): string => {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
};

/** Micros → `"1,25,000.50"` (rounded to paise, Indian grouping, no symbol). */
export const formatRupees = (micros: number): string => {
  const paise = roundDiv(Math.abs(assertMicros(micros, { allowNegative: true })), PAISA_MICROS);
  const sign = micros < 0 && paise > 0 ? '-' : '';
  const whole = Math.floor(paise / 100).toString();
  return `${sign}${groupIndian(whole)}.${String(paise % 100).padStart(2, '0')}`;
};

/** Micros → `"₹1,25,000.50"` (emails, PDFs). */
export const formatInr = (micros: number): string => {
  const text = formatRupees(micros);
  return text.startsWith('-') ? `-₹${text.slice(1)}` : `₹${text}`;
};

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Array lookup for indices that are always in range (0–19 / 0–9). */
const word = (list: readonly string[], index: number): string => list[index] as string;

const below100 = (n: number): string =>
  n < 20
    ? word(ONES, n)
    : `${word(TENS, Math.floor(n / 10))}${n % 10 ? ` ${word(ONES, n % 10)}` : ''}`;

const below1000 = (n: number): string => {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${word(ONES, h)} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
};

/** 1,25,000 → "One Lakh Twenty Five Thousand" (Indian system; 0 → "Zero"). */
export const numberInWords = (value: number): string => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Bad number: ${value}`);
  if (value === 0) return 'Zero';
  const parts: string[] = [];
  let n = value;
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${numberInWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
};

/** Micros → "Rupees One Thousand One Hundred Eighty and Fifty Paise Only". */
export const amountInWords = (micros: number): string => {
  const paise = roundDiv(assertMicros(micros), PAISA_MICROS);
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  const paisePart = rest ? ` and ${below100(rest)} Paise` : '';
  return `Rupees ${numberInWords(rupees)}${paisePart} Only`;
};
