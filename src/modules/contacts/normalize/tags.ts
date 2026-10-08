import { CONTACT_LIMITS } from '../../../config/limits';

export type TagsResult = { ok: true; tags: string[] } | { ok: false; reason: 'tags_invalid' };

const TAG = /^[\p{L}\p{M}\p{N} _-]{1,40}$/u;

/** `"VIP; overdue, VIP"` or `['vip']` → lower-case, trimmed, deduped tags (≤ 20). */
export const normalizeTags = (input: unknown): TagsResult => {
  if (input === null || input === undefined || input === '') return { ok: true, tags: [] };
  let raw: unknown[];
  if (Array.isArray(input)) raw = input;
  else if (typeof input === 'string') raw = input.split(/[,;]/);
  else return { ok: false, reason: 'tags_invalid' };

  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, reason: 'tags_invalid' };
    const tag = item.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag) continue;
    if (!TAG.test(tag)) return { ok: false, reason: 'tags_invalid' };
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags.length > CONTACT_LIMITS.tagsPerContact
    ? { ok: false, reason: 'tags_invalid' }
    : { ok: true, tags };
};

/** One tag (filters, bulk payloads) — same rules, undefined when invalid. */
export const normalizeTag = (input: string): string | undefined => {
  const result = normalizeTags([input]);
  return result.ok && result.tags.length === 1 ? result.tags[0] : undefined;
};
