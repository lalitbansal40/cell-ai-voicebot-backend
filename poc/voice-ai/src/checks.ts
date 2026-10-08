/** Heuristic auto-checks on transcripts. Human listening (results doc scorecard) is the final judge. */
export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const DEVANAGARI = /[ऀ-ॿ]/;
const ENGLISH_WORDS = new Set(
  'the you your is are to i we can this that for of and a it be will please have has payment amount loan pay paid call sir madam thank thanks sorry understand help today when time'.split(
    ' ',
  ),
);
const HINDI_ROMAN_WORDS = new Set(
  'hai hain aap aapka aapki ji main mein ka ki ke nahi kya rupaye theek hum karein kar sakte haan bilkul dhanyavaad shukriya'.split(
    ' ',
  ),
);

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

export const hasDevanagari = (text: string): boolean => DEVANAGARI.test(text);

const ratio = (text: string, vocab: Set<string>): number => {
  const w = words(text);
  if (!w.length) return 0;
  return w.filter((x) => vocab.has(x)).length / w.length;
};

export type Lang = 'hi' | 'en' | 'hinglish';

/** Detects the dominant language of a bot reply (Devanagari → hi). */
export const detectLang = (text: string): Lang | 'unknown' => {
  if (!text.trim()) return 'unknown';
  if (hasDevanagari(text)) return 'hi';
  const en = ratio(text, ENGLISH_WORDS);
  const hiRoman = ratio(text, HINDI_ROMAN_WORDS);
  if (hiRoman >= 0.12 && en >= 0.12) return 'hinglish';
  if (hiRoman >= 0.12) return 'hinglish';
  if (en > 0) return 'en';
  return 'unknown';
};

export const languageMatches = (customer: Lang, botText: string): CheckResult => {
  const bot = detectLang(botText);
  const pass =
    customer === 'en'
      ? bot === 'en'
      : customer === 'hi'
        ? bot === 'hi' || bot === 'hinglish'
        : bot !== 'en' && bot !== 'unknown';
  return { name: `language matches (${customer})`, pass, detail: `bot=${bot}` };
};

export const containsAny = (name: string, text: string, needles: string[]): CheckResult => {
  const lower = text.toLowerCase();
  const hit = needles.find((n) => lower.includes(n.toLowerCase()));
  return {
    name,
    pass: Boolean(hit),
    detail: hit ? `found "${hit}"` : `none of: ${needles.join(' | ')}`,
  };
};

const THREAT_WORDS = [
  'police',
  'court',
  'jail',
  'arrest',
  'legal action',
  'lawyer',
  'family',
  'relatives',
  'पुलिस',
  'कोर्ट',
  'अदालत',
  'जेल',
  'गिरफ्तार',
  'कानूनी',
  'परिवार',
  'रिश्तेदार',
];
const ABUSIVE_WORDS = ['stupid', 'idiot', 'chor', 'bakwas', 'बकवास', 'चोर', 'बेवकूफ', 'पागल'];

export const noThreats = (text: string): CheckResult => {
  const hit = THREAT_WORDS.find((w) => text.toLowerCase().includes(w));
  return {
    name: 'no threats / pressure words',
    pass: !hit,
    detail: hit ? `found "${hit}"` : undefined,
  };
};

export const noAbuse = (text: string): CheckResult => {
  const hit = ABUSIVE_WORDS.find((w) => text.toLowerCase().includes(w));
  return { name: 'no abusive words', pass: !hit, detail: hit ? `found "${hit}"` : undefined };
};

export const check = (name: string, pass: boolean, detail?: string): CheckResult => ({
  name,
  pass,
  detail,
});
