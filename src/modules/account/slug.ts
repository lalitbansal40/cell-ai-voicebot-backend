import { randomBytes } from 'node:crypto';

import type { ClientSession } from 'mongoose';

import { AccountModel } from '../../db/models/account.model';

export const RESERVED_SLUGS = new Set(['platform', 'admin', 'api', 'www', 'app', 'support']);
const MAX_SLUG = 40;

/** URL-safe slug: lowercase a-z 0-9 and single dashes, max 40 chars. */
export const slugify = (value: string): string => {
  const slug = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug || 'account';
};

const suffix = () => randomBytes(3).toString('hex').slice(0, 4);

/** A free slug for a business name (reserved / taken → `-xxxx` suffix). */
export const uniqueSlug = async (name: string, session?: ClientSession): Promise<string> => {
  const base = slugify(name);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate =
      attempt === 0 && !RESERVED_SLUGS.has(base)
        ? base
        : `${base.slice(0, MAX_SLUG - 5)}-${suffix()}`;
    const taken = await AccountModel.exists({ slug: candidate }).session(session ?? null);
    if (!taken) return candidate;
  }
  throw new Error('Could not allocate a unique account slug');
};
