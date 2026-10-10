/** NFKC, lower case, punctuation → space (letters incl. Devanagari matras, digits kept). */
export const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const containsPhrase = (haystack: string, phrase: string): boolean =>
  phrase !== '' && ` ${haystack} `.includes(` ${phrase} `);

export interface IntentLike {
  id: string;
  keywords: readonly string[];
}

/** First intent (in order) with a keyword appearing as whole words in the text, else `null`. */
export const matchIntent = (text: string, intents: readonly IntentLike[]): string | null => {
  const said = normalize(text);
  if (!said) return null;
  for (const intent of intents) {
    if (intent.keywords.some((k) => containsPhrase(said, normalize(k)))) return intent.id;
  }
  return null;
};
