/**
 * Fixed text markers shared by the prompt compiler and the fake provider, so
 * the fake can read the date, persona, tone rules and knowledge exactly like
 * a real model would see them.
 */
export const TODAY_PREFIX = "Today's date: ";
export const PERSONA_HEADING = '## Persona';
export const TONE_HEADING = '## Tone rules';
/** `- When the customer is angry: <respond>` / `- When <custom>: <respond>`. */
export const TONE_LINE = /^- When (?:the customer is )?([^:]+): (.+)$/;
export const KNOWLEDGE_OPEN = '<<<KNOWLEDGE';
export const KNOWLEDGE_CLOSE = '>>>';
/** `>>>` inside chunk text would close the block early — neutralised. */
export const escapeKnowledge = (text: string): string => text.replace(/>>>/g, '> > >');
