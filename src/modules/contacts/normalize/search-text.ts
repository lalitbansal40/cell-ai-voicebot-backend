import { phoneDigits } from './phone';

/** `contacts.searchText`: lower-case name, e-mail, phone digits, external id. */
export const buildSearchText = (parts: {
  name?: string | null;
  email?: string | null;
  phoneE164: string;
  externalId?: string | null;
}): string =>
  [parts.name, parts.email, phoneDigits(parts.phoneE164), parts.externalId]
    .filter((v): v is string => Boolean(v))
    .join(' ')
    .toLowerCase();
