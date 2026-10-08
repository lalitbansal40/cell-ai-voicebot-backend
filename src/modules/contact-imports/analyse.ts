import type { Types } from 'mongoose';

import { CONTACT_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { ContactModel, type VariableValue } from '../../db/models/contact.model';
import { DndEntryModel } from '../../db/models/dnd-entry.model';
import {
  emptyImportTotals,
  type ImportJobDoc,
  type ImportTotals,
} from '../../db/models/import-job.model';
import { loadContactContext, type ContactContext } from '../contacts/context';

import {
  applyRequired,
  buildCandidate,
  fieldsForMapping,
  type Candidate,
  type FieldInfo,
} from './candidate';
import type { ColumnMapping, ImportOptions } from './mapping';
import { parseSheet, type ParsedSheet } from './parsers';
import { readStoredFile } from './storage-io';

export type RowOutcome = 'created' | 'updated' | 'unchanged' | 'invalid' | 'duplicate';

export interface AnalysedRow {
  candidate: Candidate;
  cells: string[];
  outcome: RowOutcome;
  reasons: string[];
  /** Valid rows: final variables (existing merged + defaults). */
  variables?: Record<string, VariableValue>;
  onDnd?: boolean;
  /** The live contact with this phone, if any. */
  existing?: ExistingContact;
}

export interface ExistingContact {
  _id: Types.ObjectId;
  name?: string | null;
  email?: string | null;
  externalId?: string | null;
  variables?: Record<string, VariableValue>;
}

export interface ImportPlan {
  sheet: ParsedSheet;
  ctx: ContactContext;
  fields: Map<string, FieldInfo>;
  columns: ColumnMapping[];
  options: ImportOptions | null;
}

/** Loads the stored file + mapping context for validate / run. */
export const loadPlan = async (
  job: ImportJobDoc,
  storage: StorageProvider,
): Promise<ImportPlan> => {
  const ctx = await loadContactContext(job.accountId);
  const columns = (job.mapping as { columns?: ColumnMapping[] } | null)?.columns ?? [];
  const sheet = await parseSheet(
    await readStoredFile(storage, job.fileKey ?? ''),
    job.fileType,
    job.sheet,
  );
  return {
    sheet,
    ctx,
    fields: fieldsForMapping(ctx, columns),
    columns,
    options: (job.options as ImportOptions | null) ?? null,
  };
};

/**
 * Classifies rows in batches (PHASE_3_PLAN §1c): invalid, duplicate in file
 * (first occurrence wins), created / updated / unchanged, on the DND list.
 * `seen` carries in-file duplicates across batches and resumed runs.
 */
export const analyseBatch = async (
  job: Pick<ImportJobDoc, 'accountId' | 'kind'>,
  plan: ImportPlan,
  rows: ParsedSheet['rows'],
  seen: Map<string, number>,
): Promise<AnalysedRow[]> => {
  const candidates = rows.map((r) => ({
    cells: r.cells,
    candidate: buildCandidate(r, plan.columns, plan.fields, plan.ctx),
  }));
  const phones = [
    ...new Set(candidates.map((c) => c.candidate.phoneE164).filter((p): p is string => Boolean(p))),
  ];

  const existing = new Map<string, ExistingContact>();
  const externalOwner = new Map<string, string>();
  const dnd = new Set<string>();
  if (phones.length) {
    if (job.kind === 'contacts') {
      const found = await ContactModel.find({
        accountId: job.accountId,
        phoneE164: { $in: phones },
      })
        .select({ phoneE164: 1, name: 1, email: 1, externalId: 1, variables: 1 })
        .lean<(ExistingContact & { phoneE164: string })[]>();
      for (const c of found) existing.set(c.phoneE164, c);
      const externalIds = [
        ...new Set(
          candidates.map((c) => c.candidate.externalId).filter((e): e is string => Boolean(e)),
        ),
      ];
      if (externalIds.length) {
        const owners = await ContactModel.find({
          accountId: job.accountId,
          externalId: { $in: externalIds },
        })
          .select({ externalId: 1, phoneE164: 1 })
          .lean<{ externalId: string; phoneE164: string }[]>();
        for (const o of owners) externalOwner.set(o.externalId, o.phoneE164);
      }
    }
    const entries = await DndEntryModel.find({
      accountId: job.accountId,
      phoneE164: { $in: phones },
    })
      .select({ phoneE164: 1 })
      .lean<{ phoneE164: string }[]>();
    for (const e of entries) dnd.add(e.phoneE164);
  }

  const updateExisting = plan.options?.updateExisting ?? true;
  return candidates.map(({ cells, candidate }) => {
    const phone = candidate.phoneE164;
    if (phone && seen.has(phone)) {
      return {
        candidate,
        cells,
        outcome: 'duplicate',
        reasons: [`duplicate_of_row:${seen.get(phone) ?? 0}`],
      };
    }
    if (phone) seen.set(phone, candidate.rowNumber);
    const ext = candidate.externalId;
    if (ext && job.kind === 'contacts') {
      const firstRow = seen.get(`ext:${ext}`);
      const owner = externalOwner.get(ext);
      if (firstRow !== undefined) candidate.reasons.push(`duplicate_external_id:${firstRow}`);
      else if (owner && owner !== phone) candidate.reasons.push('external_id_taken');
      else seen.set(`ext:${ext}`, candidate.rowNumber);
    }
    if (candidate.reasons.length || !phone) {
      return {
        candidate,
        cells,
        outcome: 'invalid',
        reasons: candidate.reasons.length ? candidate.reasons : ['phone_missing'],
      };
    }
    if (job.kind === 'dnd') {
      return { candidate, cells, outcome: dnd.has(phone) ? 'unchanged' : 'created', reasons: [] };
    }
    const match = existing.get(phone);
    const required = applyRequired(
      candidate,
      plan.fields,
      match ? (match.variables ?? {}) : undefined,
    );
    if (required.reasons.length)
      return { candidate, cells, outcome: 'invalid', reasons: required.reasons };
    return {
      candidate,
      cells,
      outcome: match ? (updateExisting ? 'updated' : 'unchanged') : 'created',
      reasons: [],
      variables: required.variables,
      onDnd: dnd.has(phone),
      ...(match ? { existing: match } : {}),
    };
  });
};

/** Adds analysed rows to the totals. */
export const addToTotals = (totals: ImportTotals, rows: AnalysedRow[]): ImportTotals => {
  const next = { ...totals };
  for (const r of rows) {
    next.rows += 1;
    if (r.outcome === 'duplicate') next.duplicates += 1;
    else if (r.outcome === 'invalid') next.invalid += 1;
    else next[r.outcome] += 1;
    if (r.onDnd) next.dnd += 1;
  }
  return next;
};

export const batches = <T>(items: T[], size: number = CONTACT_LIMITS.importBatchSize): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

export { emptyImportTotals };
