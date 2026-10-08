import type { CountryCode } from 'libphonenumber-js';

import { CONTACT_LIMITS } from '../../config/limits';
import type { CustomFieldDoc, FieldType } from '../../db/models/custom-field.model';
import type { ImportKind } from '../../db/models/import-job.model';
import type { ErrorDetail } from '../../shared/errors/app-error';
import { normalizePhone } from '../contacts/normalize/phone';
import { cleanDecimal, parseDate, type DateFormat } from '../contacts/normalize/values';
import { FIELD_KEY, RESERVED_FIELD_KEYS } from '../custom-fields/custom-fields.schema';

export const CONTACT_TARGETS = [
  'name',
  'phone',
  'email',
  'external_id',
  'tags',
  'consent_at',
  'field',
  'new_field',
  'ignore',
] as const;
export const DND_TARGETS = ['phone', 'reason', 'ignore'] as const;
export type MappingTarget = (typeof CONTACT_TARGETS)[number] | (typeof DND_TARGETS)[number];

export interface ColumnMapping {
  index: number;
  target: MappingTarget;
  /** `field` / `new_field`: the field key. */
  key?: string;
  /** `new_field`: label + type of the field to create when the import starts. */
  label?: string;
  type?: FieldType;
  /** Date columns (fields of type date, `consent_at`). */
  dateFormat?: DateFormat;
}

export interface ImportOptions {
  list: { mode: 'new'; name: string } | { mode: 'existing'; listId: string };
  updateExisting: boolean;
  tags: string[];
  consentSource?: string | null;
}

export interface ImportMapping {
  columns: ColumnMapping[];
}

const squash = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9\p{Script=Devanagari}]/gu, '');

const ALIASES: Record<'phone' | 'name' | 'email' | 'external_id' | 'tags', string[]> = {
  phone: [
    'phone',
    'phoneno',
    'phonenumber',
    'mobile',
    'mobileno',
    'mobilenumber',
    'mob',
    'mobno',
    'contact',
    'contactno',
    'contactnumber',
    'number',
    'cell',
    'whatsapp',
    'whatsappno',
  ],
  name: [
    'name',
    'naam',
    'fullname',
    'customer',
    'customername',
    'custname',
    'borrower',
    'borrowername',
    'clientname',
  ],
  email: ['email', 'emailid', 'emailaddress', 'mail', 'mailid'],
  external_id: [
    'externalid',
    'loanid',
    'loanno',
    'loannumber',
    'loanaccount',
    'loanaccountno',
    'accountno',
    'accountnumber',
    'customerid',
    'custid',
    'agreementno',
    'id',
  ],
  tags: ['tags', 'tag', 'labels', 'label'],
};

const MONEY_HINT = /(amount|amt|emi|balance|outstanding|due amt|dues|principal|interest|rs|inr|₹)/i;

/** Field key from a header: `Loan Amt (Rs)` → `loan_amt_rs`. */
export const slugKey = (header: string): string => {
  let key = header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!key) key = 'field';
  if (!/^[a-z]/.test(key)) key = `f_${key}`.slice(0, 40);
  return key;
};

const share = (samples: string[], test: (s: string) => boolean): number =>
  samples.length ? samples.filter(test).length / samples.length : 0;

/** Type of a new field, guessed from its header and sample values (≥ 80 % rule). */
export const guessType = (
  header: string,
  samples: string[],
  country: CountryCode = 'IN',
): FieldType => {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  if (!values.length) return 'text';
  const isNumber = (s: string) => cleanDecimal(s) !== undefined;
  const looksDate = (s: string) => /[-/.a-z]/i.test(s) && parseDate(s) !== undefined;
  if (share(values, looksDate) >= 0.8) return 'date';
  if (share(values, (s) => /^(₹|rs\.?|inr)/i.test(s) && isNumber(s)) >= 0.8) return 'currency';
  if (share(values, (s) => /^[+\d\s()-]{10,}$/.test(s) && normalizePhone(s, country).ok) >= 0.8)
    return 'phone';
  if (share(values, isNumber) >= 0.8) return MONEY_HINT.test(header) ? 'currency' : 'number';
  return 'text';
};

/** Suggested target per column (header aliases, existing fields, else a new field). */
export const suggestMapping = (
  kind: ImportKind,
  columns: { index: number; header: string; samples: string[] }[],
  fields: Pick<CustomFieldDoc, 'key' | 'label' | 'type'>[],
  country: CountryCode = 'IN',
): ColumnMapping[] => {
  const used = new Set<string>();
  const keys = new Set(fields.map((f) => f.key));
  return columns.map(({ index, header, samples }) => {
    const h = squash(header);
    if (kind === 'dnd') {
      if (!used.has('phone') && ALIASES.phone.includes(h)) {
        used.add('phone');
        return { index, target: 'phone' };
      }
      if (!used.has('reason') && ['reason', 'remark', 'remarks', 'note', 'notes'].includes(h)) {
        used.add('reason');
        return { index, target: 'reason' };
      }
      return { index, target: 'ignore' };
    }
    for (const target of ['phone', 'name', 'email', 'external_id', 'tags'] as const) {
      if (!used.has(target) && ALIASES[target].includes(h)) {
        used.add(target);
        return { index, target };
      }
    }
    const field = fields.find(
      (f) => !used.has(`field:${f.key}`) && (squash(f.key) === h || squash(f.label) === h),
    );
    if (field) {
      used.add(`field:${field.key}`);
      return {
        index,
        target: 'field',
        key: field.key,
        ...(field.type === 'date' ? { dateFormat: 'DMY' as const } : {}),
      };
    }
    let key = slugKey(header);
    if ((RESERVED_FIELD_KEYS as readonly string[]).includes(key)) key = `${key}_value`.slice(0, 40);
    for (let n = 2; keys.has(key); n += 1) key = `${slugKey(header).slice(0, 36)}_${n}`;
    keys.add(key);
    const type = guessType(header, samples, country);
    return {
      index,
      target: 'new_field',
      key,
      label: header.slice(0, 80),
      type,
      ...(type === 'date' ? { dateFormat: 'DMY' as const } : {}),
    };
  });
};

/** Mapping rules (PHASE_3_PLAN §1c) → 422 details; empty array = valid. */
export const validateMapping = (
  kind: ImportKind,
  mapping: ImportMapping,
  columnCount: number,
  fields: Pick<CustomFieldDoc, 'key' | 'type'>[],
): ErrorDetail[] => {
  const errors: ErrorDetail[] = [];
  const allowed: readonly string[] = kind === 'dnd' ? DND_TARGETS : CONTACT_TARGETS;
  const existing = new Map(fields.map((f) => [f.key, f]));
  const seenIndex = new Set<number>();
  const seenTarget = new Set<string>();
  let newFields = 0;

  mapping.columns.forEach((col, i) => {
    const at = `columns.${i}`;
    if (col.index < 0 || col.index >= columnCount)
      errors.push({ path: `${at}.index`, message: 'No such column' });
    if (seenIndex.has(col.index))
      errors.push({ path: `${at}.index`, message: 'Column mapped twice' });
    seenIndex.add(col.index);
    if (!allowed.includes(col.target)) {
      errors.push({ path: `${at}.target`, message: `Not allowed for a ${kind} import` });
      return;
    }
    if (col.target === 'ignore') return;
    const id =
      col.target === 'field' || col.target === 'new_field' ? `key:${col.key ?? ''}` : col.target;
    if (seenTarget.has(id))
      errors.push({ path: `${at}.target`, message: 'Each target can be used once' });
    seenTarget.add(id);

    if (col.target === 'field') {
      if (!col.key || !existing.has(col.key))
        errors.push({ path: `${at}.key`, message: 'Unknown field' });
    }
    if (col.target === 'new_field') {
      newFields += 1;
      if (
        !col.key ||
        !FIELD_KEY.test(col.key) ||
        (RESERVED_FIELD_KEYS as readonly string[]).includes(col.key)
      ) {
        errors.push({ path: `${at}.key`, message: 'Invalid or reserved key' });
      } else if (existing.has(col.key)) {
        errors.push({
          path: `${at}.key`,
          message: 'A field with this key already exists — map to it instead',
        });
      }
      if (!col.label?.trim()) errors.push({ path: `${at}.label`, message: 'Enter a label' });
      if (!col.type) errors.push({ path: `${at}.type`, message: 'Choose a type' });
    }
  });

  if (!seenTarget.has('phone'))
    errors.push({ path: 'columns', message: 'Map exactly one column to Phone' });
  if (fields.length + newFields > CONTACT_LIMITS.customFieldsPerAccount) {
    errors.push({
      path: 'columns',
      message: `An account can have at most ${CONTACT_LIMITS.customFieldsPerAccount} custom fields`,
    });
  }
  return errors;
};
