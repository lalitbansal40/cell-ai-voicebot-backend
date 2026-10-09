import type { Types } from 'mongoose';

import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { CustomFieldModel, type CustomFieldDoc } from '../../db/models/custom-field.model';
import { NotFoundError } from '../../shared/errors/app-error';
import { formatInr } from '../../shared/money';

/** Contact facts the model may be allowed to see besides custom fields. */
export const BUILT_IN_VARIABLES = ['name', 'phone_last4'] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const readableDate = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? ''} ${m[1] ?? ''}` : ymd;
};

export interface VariableInfo {
  name: string;
  label: string;
  type: 'text' | 'number' | 'currency' | 'date' | 'phone' | 'built_in';
}

/** Every variable an agent of this account may allow (built-ins + custom field keys). */
export const accountVariables = async (accountId: Types.ObjectId): Promise<VariableInfo[]> => {
  const fields = await CustomFieldModel.find({ accountId })
    .sort({ order: 1, key: 1 })
    .select({ key: 1, label: 1, type: 1 })
    .lean<Pick<CustomFieldDoc, 'key' | 'label' | 'type'>[]>();
  return [
    { name: 'name', label: 'Name', type: 'built_in' },
    { name: 'phone_last4', label: 'Last 4 digits of the phone', type: 'built_in' },
    ...fields.map((f) => ({ name: f.key, label: f.label, type: f.type })),
  ];
};

const formatValue = (type: VariableInfo['type'], value: unknown): string => {
  if (value === null || value === undefined || value === '') return '';
  // whole rupees read better without paise ("₹12,500", not "₹12,500.00")
  if (type === 'currency' && typeof value === 'number')
    return formatInr(value).replace(/\.00$/, '');
  if (type === 'date' && typeof value === 'string') return readableDate(value);
  if (type === 'number' && typeof value === 'number') return value.toLocaleString('en-IN');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
};

export interface ContactVariables {
  /** Allowed values only, readable (what the model sees). */
  values: Record<string, string>;
  /** Full contact for function templates (server-side only). */
  contact: Pick<ContactDoc, 'phoneE164' | 'name' | 'externalId' | 'variables'>;
}

/** Values of the allowed variables for one contact of the account. */
export const contactVariables = async (
  accountId: Types.ObjectId,
  contactId: Types.ObjectId,
  allowed: string[],
): Promise<ContactVariables> => {
  const contact = await ContactModel.findOne({ _id: contactId, accountId })
    .select({ phoneE164: 1, name: 1, externalId: 1, variables: 1 })
    .lean<Pick<ContactDoc, 'phoneE164' | 'name' | 'externalId' | 'variables'>>();
  if (!contact) throw new NotFoundError('Contact not found');
  const types = new Map((await accountVariables(accountId)).map((v) => [v.name, v.type]));
  const vars = (contact.variables ?? {}) as unknown as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const name of allowed) {
    if (name === 'name') values.name = contact.name ?? '';
    else if (name === 'phone_last4') values.phone_last4 = contact.phoneE164.slice(-4);
    else values[name] = formatValue(types.get(name) ?? 'text', vars[name]);
  }
  return { values, contact };
};

/** Manual playground / preview values: only allowed names, trimmed, ≤ 200 chars. */
export const manualVariables = (
  input: Record<string, string> | undefined,
  allowed: string[],
): Record<string, string> =>
  Object.fromEntries(allowed.map((name) => [name, (input?.[name] ?? '').trim().slice(0, 200)]));
