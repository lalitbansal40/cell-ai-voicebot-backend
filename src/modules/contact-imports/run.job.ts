import type { Job } from 'bullmq';
import { Types, type AnyBulkWriteOperation } from 'mongoose';

import { notifyAccount } from '../../core/realtime/notify';
import { AccountModel } from '../../db/models/account.model';
import { ContactModel, type ContactDoc } from '../../db/models/contact.model';
import { ImportJobModel, type ImportJobDoc } from '../../db/models/import-job.model';
import { recordAudit } from '../audit/audit.service';
import type { ContactJobData } from '../contacts/jobs';
import { acquireJobLock, refreshJobLock, releaseJobLock } from '../contacts/locks';
import { buildSearchText } from '../contacts/normalize';
import { createProgressReporter } from '../contacts/progress';
import { addDndEntries } from '../dnd/dnd.service';

import {
  addToTotals,
  analyseBatch,
  batches,
  loadPlan,
  type AnalysedRow,
  type ImportPlan,
} from './analyse';
import { buildCandidate } from './candidate';
import type { ImportJobDeps } from './validate.job';

class StopImport extends Error {
  constructor(readonly outcome: 'canceled' | 'account_suspended') {
    super(outcome);
  }
}

const isFileProblem = (err: unknown) => (err as { code?: string }).code === 'IMPORT_FILE_INVALID';

/** Rebuilds the "seen" phones / external ids of rows before the checkpoint (resume). */
const replaySeen = (plan: ImportPlan, upTo: number): Map<string, number> => {
  const seen = new Map<string, number>();
  for (const row of plan.sheet.rows.slice(0, upTo)) {
    const c = buildCandidate(row, plan.columns, plan.fields, plan.ctx);
    if (c.phoneE164 && !seen.has(c.phoneE164)) seen.set(c.phoneE164, c.rowNumber);
    if (c.externalId && !seen.has(`ext:${c.externalId}`))
      seen.set(`ext:${c.externalId}`, c.rowNumber);
  }
  return seen;
};

/** Contact writes for one batch: revive deleted phones, insert new, merge existing. */
const contactWrites = async (
  job: ImportJobDoc,
  plan: ImportPlan,
  rows: AnalysedRow[],
): Promise<AnyBulkWriteOperation<ContactDoc>[]> => {
  const listId = job.listId ?? null;
  const options = plan.options;
  const extraTags = options?.tags ?? [];
  const consentFor = (r: AnalysedRow) =>
    options?.consentSource
      ? {
          source: options.consentSource,
          at: r.candidate.consentAt ? new Date(r.candidate.consentAt) : new Date(),
        }
      : undefined;

  const created = rows.filter((r) => r.outcome === 'created');
  const deleted = created.length
    ? await ContactModel.find({
        accountId: job.accountId,
        phoneE164: { $in: created.map((r) => r.candidate.phoneE164 as string) },
        deletedAt: { $ne: null },
      })
        .sort({ deletedAt: -1 })
        .select({ phoneE164: 1 })
        .lean<{ _id: Types.ObjectId; phoneE164: string }[]>()
    : [];
  const revive = new Map<string, Types.ObjectId>();
  for (const d of deleted) if (!revive.has(d.phoneE164)) revive.set(d.phoneE164, d._id);

  const ops: AnyBulkWriteOperation<ContactDoc>[] = [];
  for (const r of rows) {
    const c = r.candidate;
    const phone = c.phoneE164 as string;
    const tags = [...new Set([...c.tags, ...extraTags])];
    if (r.outcome === 'created') {
      const doc = {
        accountId: job.accountId,
        phoneE164: phone,
        name: c.name ?? null,
        email: c.email ?? null,
        externalId: c.externalId ?? null,
        variables: r.variables ?? {},
        tags,
        listIds: listId ? [listId] : [],
        dnd: Boolean(r.onDnd),
        optedOutAt: null,
        consent: consentFor(r) ?? null,
        source: { type: 'import' as const, importJobId: job._id },
        searchText: buildSearchText({
          name: c.name,
          email: c.email,
          phoneE164: phone,
          externalId: c.externalId,
        }),
        lastCalledAt: null,
        callCount: 0,
      };
      const deletedId = revive.get(phone);
      // A revived contact keeps its opt-out and call history (compliance record).
      const {
        optedOutAt: _optedOut,
        lastCalledAt: _lastCalled,
        callCount: _calls,
        ...revived
      } = doc;
      ops.push(
        deletedId
          ? {
              updateOne: {
                filter: { _id: deletedId, accountId: job.accountId },
                update: { $set: { ...revived, deletedAt: null } },
              },
            }
          : {
              updateOne: {
                filter: { accountId: job.accountId, phoneE164: phone, deletedAt: null },
                update: { $setOnInsert: { ...doc, deletedAt: null } },
                upsert: true,
              },
            },
      );
      continue;
    }
    if (!r.existing) continue;
    const addToSet = {
      ...(listId ? { listIds: listId } : {}),
      ...(r.outcome === 'updated' && tags.length ? { tags: { $each: tags } } : {}),
    };
    if (r.outcome === 'unchanged') {
      if (listId)
        ops.push({
          updateOne: { filter: { _id: r.existing._id }, update: { $addToSet: addToSet } },
        });
      continue;
    }
    // updated: empty cells never clear values
    const set: Record<string, unknown> = {};
    if (c.name) set.name = c.name;
    if (c.email) set.email = c.email;
    if (c.externalId) set.externalId = c.externalId;
    for (const [key, value] of Object.entries(c.variables)) set[`variables.${key}`] = value;
    const consent = consentFor(r);
    if (consent) set.consent = consent;
    set.searchText = buildSearchText({
      name: c.name ?? r.existing.name,
      email: c.email ?? r.existing.email,
      phoneE164: phone,
      externalId: c.externalId ?? r.existing.externalId,
    });
    ops.push({
      updateOne: {
        filter: { _id: r.existing._id },
        update: { $set: set, ...(Object.keys(addToSet).length ? { $addToSet: addToSet } : {}) },
      },
    });
  }
  return ops;
};

/** Writes one analysed batch; a lost race (E11000) re-analyses the batch once. */
const writeBatch = async (
  job: ImportJobDoc,
  plan: ImportPlan,
  rows: ImportPlan['sheet']['rows'],
  seen: Map<string, number>,
): Promise<AnalysedRow[]> => {
  const before = new Map(seen);
  for (let attempt = 0; ; attempt += 1) {
    const analysed = await analyseBatch(job, plan, rows, seen);
    try {
      if (job.kind === 'dnd') {
        await addDndEntries(
          job.accountId,
          analysed
            .filter((r) => r.outcome === 'created')
            .map((r) => ({
              phoneE164: r.candidate.phoneE164 as string,
              reason: r.candidate.reason ?? null,
            })),
          'upload',
          job.createdBy,
        );
      } else {
        const ops = await contactWrites(job, plan, analysed);
        if (ops.length) await ContactModel.bulkWrite(ops, { ordered: false });
      }
      return analysed;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000 || attempt >= 1) throw err;
      seen.clear();
      for (const [k, v] of before) seen.set(k, v);
    }
  }
};

const finish = async (
  job: ImportJobDoc,
  status: 'completed' | 'canceled' | 'failed',
  extra: Record<string, unknown> = {},
) => {
  const now = new Date();
  const stamp =
    status === 'completed'
      ? { completedAt: now }
      : status === 'canceled'
        ? { canceledAt: now }
        : { failedAt: now };
  await ImportJobModel.updateOne(
    { _id: job._id, status: 'importing' },
    { $set: { status, ...stamp, ...extra } },
  );
};

/**
 * `import.run` — batches of 500 with a checkpoint after each, so a retried
 * job resumes where it stopped (PHASE_3_PLAN T3.9).
 */
export const runImport = async (
  { accountId, importJobId }: ContactJobData['import.run'],
  { storage, logger }: ImportJobDeps,
  bullJob?: Pick<Job, 'attemptsMade' | 'opts'>,
): Promise<{ status: string }> => {
  const _id = new Types.ObjectId(importJobId);
  let job = await ImportJobModel.findOne({
    _id,
    accountId: new Types.ObjectId(accountId),
  }).lean<ImportJobDoc>();
  if (job?.status !== 'importing') return { status: job?.status ?? 'missing' };
  await acquireJobLock('import', accountId, importJobId);
  const report = createProgressReporter(accountId, 'import.progress', { importJobId });
  const actor = { type: 'user' as const, id: job.createdBy };
  const target = { type: 'import_job', id: importJobId };
  try {
    const plan = await loadPlan(job, storage);
    const total = plan.sheet.rows.length;
    const start = job.progress.processed;
    const seen = replaySeen(plan, start);
    let totals = { ...job.totals };
    let processed = start;
    report(processed, total, 'importing', true);

    for (const batch of batches(plan.sheet.rows.slice(start))) {
      const fresh = await ImportJobModel.findById(_id)
        .select({ cancelRequested: 1 })
        .lean<{ cancelRequested?: boolean }>();
      if (fresh?.cancelRequested) throw new StopImport('canceled');
      const account = await AccountModel.findById(job.accountId)
        .select({ status: 1 })
        .lean<{ status?: string }>();
      if (account?.status === 'suspended') throw new StopImport('account_suspended');

      const analysed = await writeBatch(job, plan, batch, seen);
      totals = addToTotals(totals, analysed);
      processed += batch.length;
      await ImportJobModel.updateOne(
        { _id },
        { $set: { 'progress.processed': processed, 'progress.total': total, totals } },
      );
      await refreshJobLock('import', accountId, importJobId);
      report(processed, total, 'importing');
    }

    await finish(job, 'completed', { totals, progress: { processed, total } });
    await recordAudit({
      accountId: job.accountId,
      actor,
      action: 'contacts.import_completed',
      target,
      meta: { kind: job.kind, ...totals },
    });
    if (job.kind === 'dnd' && totals.created) {
      await recordAudit({
        accountId: job.accountId,
        actor,
        action: 'dnd.added',
        target,
        meta: { count: totals.created, source: 'upload' },
      });
    }
    notifyAccount(accountId, 'contacts.changed', { reason: job.kind === 'dnd' ? 'dnd' : 'import' });
    report(processed, total, 'completed', true);
    logger.info({ importJobId, ...totals }, 'contacts: import completed');
    await releaseJobLock('import', accountId, importJobId);
    return { status: 'completed' };
  } catch (err) {
    job = (await ImportJobModel.findById(_id).lean<ImportJobDoc>()) ?? job;
    const processed = job.progress.processed;
    if (err instanceof StopImport) {
      if (err.outcome === 'canceled') {
        await finish(job, 'canceled');
        await recordAudit({
          accountId: job.accountId,
          actor,
          action: 'contacts.import_canceled',
          target,
          meta: { processed },
        });
      } else {
        await finish(job, 'failed', {
          errorMessage: 'The account was suspended during the import.',
        });
      }
    } else {
      const attempts = bullJob?.opts.attempts ?? 1;
      const lastAttempt = !bullJob || bullJob.attemptsMade + 1 >= attempts;
      logger.warn(
        { importJobId, processed, err: err instanceof Error ? err.name : 'error' },
        'contacts: import batch failed',
      );
      if (!lastAttempt && !isFileProblem(err)) throw err; // BullMQ retries; resumes from the checkpoint
      await finish(job, 'failed', {
        errorMessage: isFileProblem(err)
          ? (err as Error).message
          : `The import stopped after ${processed} rows. Rows already imported are kept — upload the file again to finish.`,
      });
    }
    if (processed > 0)
      notifyAccount(accountId, 'contacts.changed', {
        reason: job.kind === 'dnd' ? 'dnd' : 'import',
      });
    const final = await ImportJobModel.findById(_id)
      .select({ status: 1 })
      .lean<{ status: string }>();
    report(processed, job.rowCount, final?.status ?? 'failed', true);
    await releaseJobLock('import', accountId, importJobId);
    return { status: final?.status ?? 'failed' };
  }
};
