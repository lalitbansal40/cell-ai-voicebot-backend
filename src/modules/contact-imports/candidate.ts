import type { VariableValue } from '../../db/models/contact.model';
import type { FieldType } from '../../db/models/custom-field.model';
import type { ContactContext } from '../contacts/context';
import {
  normalizeEmail,
  normalizePhone,
  normalizeTags,
  parseDate,
  parseFieldValue,
} from '../contacts/normalize';

import type { ColumnMapping } from './mapping';

/** One sheet row after normalisation — the same code path for validate and import. */
export interface Candidate {
  rowNumber: number;
  phoneE164?: string;
  name?: string;
  email?: string;
  externalId?: string;
  tags: string[];
  consentAt?: string;
  /** DND imports: the reason column. */
  reason?: string;
  variables: Record<string, VariableValue>;
  reasons: string[];
}

export interface FieldInfo {
  type: FieldType;
  required: boolean;
  defaultValue?: string | number | null;
}

/** Existing fields + the `new_field` columns of the mapping (not required, no default). */
export const fieldsForMapping = (
  ctx: ContactContext,
  columns: ColumnMapping[],
): Map<string, FieldInfo> => {
  const map = new Map<string, FieldInfo>(
    ctx.fields.map((f) => [
      f.key,
      { type: f.type, required: f.required, defaultValue: f.defaultValue ?? null },
    ]),
  );
  for (const col of columns) {
    if (col.target === 'new_field' && col.key && col.type)
      map.set(col.key, { type: col.type, required: false });
  }
  return map;
};

/** Normalises one row by the mapping; problems become `reasons` (row stays in the report). */
export const buildCandidate = (
  row: { rowNumber: number; cells: string[] },
  columns: ColumnMapping[],
  fields: Map<string, FieldInfo>,
  ctx: Pick<ContactContext, 'country'>,
): Candidate => {
  const out: Candidate = { rowNumber: row.rowNumber, tags: [], variables: {}, reasons: [] };
  for (const col of columns) {
    const raw = (row.cells[col.index] ?? '').trim();
    switch (col.target) {
      case 'phone': {
        const phone = normalizePhone(raw, ctx.country);
        if (phone.ok) out.phoneE164 = phone.e164;
        else out.reasons.push(phone.reason);
        break;
      }
      case 'name':
        if (raw) out.name = raw.slice(0, 120);
        break;
      case 'email': {
        const email = normalizeEmail(raw);
        if (!email.ok) out.reasons.push('email_invalid');
        else if (email.value) out.email = email.value;
        break;
      }
      case 'external_id':
        if (raw) out.externalId = raw.slice(0, 100);
        break;
      case 'tags': {
        const tags = normalizeTags(raw);
        if (tags.ok) out.tags = tags.tags;
        else out.reasons.push('tags_invalid');
        break;
      }
      case 'consent_at': {
        if (!raw) break;
        const day = parseDate(raw, col.dateFormat ?? 'DMY');
        if (day) out.consentAt = day;
        else out.reasons.push('type_invalid:consent_at');
        break;
      }
      case 'reason':
        if (raw) out.reason = raw.slice(0, 200);
        break;
      case 'field':
      case 'new_field': {
        const key = col.key as string;
        const field = fields.get(key);
        if (!field) break;
        const parsed = parseFieldValue(field.type, raw, {
          country: ctx.country,
          dateFormat: col.dateFormat ?? 'DMY',
        });
        if (!parsed.ok) out.reasons.push(`${parsed.reason}:${key}`);
        else if (parsed.value !== undefined) out.variables[key] = parsed.value;
        break;
      }
      default:
        break;
    }
  }
  return out;
};

/**
 * Required fields after merging with an existing contact's values; defaults
 * fill new contacts only. Returns the final variables and `missing_required:` reasons.
 */
export const applyRequired = (
  candidate: Candidate,
  fields: Map<string, FieldInfo>,
  existing: Record<string, VariableValue> | undefined,
): { variables: Record<string, VariableValue>; reasons: string[] } => {
  const variables = { ...(existing ?? {}), ...candidate.variables };
  const reasons: string[] = [];
  for (const [key, field] of fields) {
    if (variables[key] !== undefined) continue;
    if (!existing && field.defaultValue !== undefined && field.defaultValue !== null) {
      variables[key] = field.defaultValue;
    } else if (field.required) {
      reasons.push(`missing_required:${key}`);
    }
  }
  return { variables, reasons };
};
