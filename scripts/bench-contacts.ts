/**
 * DEV ONLY — Phase 3 performance check (PHASE_3_PLAN T3.12).
 *   npm run bench:contacts            (default 50,000 rows)
 *   npm run bench:contacts -- 10000
 * Creates a throw-away account, runs the real validate + import jobs on a
 * generated sheet, times contact list queries, then deletes everything it made.
 * Needs `npm run infra:up`. Refuses NODE_ENV=production.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Types } from 'mongoose';

import { getEnv } from '../src/config/env';
import { closeAllRedis } from '../src/core/queues/redis';
import { LocalStorage, signingKey, storageKey } from '../src/core/storage';
import { AccountModel } from '../src/db/models/account.model';
import { AuditLogModel } from '../src/db/models/audit-log.model';
import { ContactListModel } from '../src/db/models/contact-list.model';
import { ContactModel } from '../src/db/models/contact.model';
import { CustomFieldModel } from '../src/db/models/custom-field.model';
import { emptyImportTotals, ImportJobModel } from '../src/db/models/import-job.model';
import { RoleModel } from '../src/db/models/role.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { columnsOf } from '../src/modules/contact-imports/contact-imports.service';
import { suggestMapping } from '../src/modules/contact-imports/mapping';
import { parseSheet } from '../src/modules/contact-imports/parsers';
import { runImport } from '../src/modules/contact-imports/run.job';
import { validateImport } from '../src/modules/contact-imports/validate.job';
import { compileContext, loadContactContext } from '../src/modules/contacts/context';
import { compileContactFilter } from '../src/modules/contacts/filter/compile';
import type { ContactFilter } from '../src/modules/contacts/filter/filter.schema';
import { createLogger } from '../src/shared/logger';

const rowsCsv = (n: number): Buffer => {
  const lines = ['Name,Mobile No,Loan Amount,Due Date,DPD,Branch'];
  for (let i = 0; i < n; i += 1) {
    lines.push(
      `Bench Borrower ${i},9${String(100_000_000 + i).slice(-9)},${5000 + (i % 900) * 10},${String((i % 28) + 1).padStart(2, '0')}/10/2026,${i % 120},Branch ${i % 40}`,
    );
  }
  return Buffer.from(`${lines.join('\r\n')}\r\n`);
};

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

const timeQuery = async (
  label: string,
  accountId: Types.ObjectId,
  filter: ContactFilter,
  runs = 20,
) => {
  const ctx = await loadContactContext(accountId);
  const { query } = compileContactFilter(accountId, filter, compileContext(ctx));
  const ms: number[] = [];
  let total = 0;
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    const [, count] = await Promise.all([
      ContactModel.find(query).sort({ createdAt: -1, _id: -1 }).limit(20).lean(),
      ContactModel.countDocuments(query),
    ]);
    total = count;
    ms.push(performance.now() - started);
  }
  console.info(
    `  ${label.padEnd(34)} matches ${String(total).padStart(6)}  p50 ${percentile(ms, 50).toFixed(0)} ms  p95 ${percentile(ms, 95).toFixed(0)} ms`,
  );
};

const main = async () => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('bench:contacts is disabled in production');
  const rows = Number(process.argv[2] ?? 50_000);
  const logger = createLogger({ NODE_ENV: env.NODE_ENV, LOG_LEVEL: 'warn' });
  await connectMongo(env, logger);
  const root = mkdtempSync(path.join(tmpdir(), 'cav-bench-'));
  const storage = new LocalStorage(root, env.APP_URL, signingKey(env));
  const account = await AccountModel.create({ name: 'Bench', slug: `bench-${Date.now()}` });
  const accountId = account._id;
  try {
    await CustomFieldModel.create({
      accountId,
      key: 'loan_amount',
      label: 'Loan Amount',
      type: 'currency',
      order: 1,
    });
    const buffer = rowsCsv(rows);
    const sheet = await parseSheet(buffer, 'csv');
    const ctx = await loadContactContext(accountId);
    const columns = suggestMapping('contacts', columnsOf(sheet), ctx.fields, 'IN');
    const _id = new Types.ObjectId();
    const fileKey = storageKey({
      accountId: accountId.toString(),
      area: 'imports',
      id: _id.toString(),
      ext: 'csv',
    });
    await storage.put(fileKey, buffer, { contentType: 'text/csv' });
    const list = await ContactListModel.create({
      accountId,
      name: 'Bench',
      source: { type: 'upload', fileName: 'bench.csv' },
    });
    await ImportJobModel.create({
      _id,
      accountId,
      kind: 'contacts',
      fileName: 'bench.csv',
      fileKey,
      fileType: 'csv',
      fileSize: buffer.length,
      columns: columnsOf(sheet),
      rowCount: sheet.rows.length,
      mapping: { columns },
      options: {
        list: { mode: 'existing', listId: list._id.toString() },
        updateExisting: true,
        tags: [],
      },
      status: 'validating',
      progress: { processed: 0, total: sheet.rows.length },
      createdBy: new Types.ObjectId(),
    });
    const deps = { storage, logger };
    const ids = { accountId: accountId.toString(), importJobId: _id.toString() };

    console.info(
      `Contact import benchmark — ${rows.toLocaleString('en-IN')} rows (${(buffer.length / 1e6).toFixed(1)} MB)`,
    );
    let started = performance.now();
    await validateImport(ids, deps);
    console.info(
      `  validate (dry run)                 ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );

    for (const col of columns) {
      if (col.target === 'new_field' && col.key && col.type) {
        await CustomFieldModel.create({
          accountId,
          key: col.key,
          label: col.label,
          type: col.type,
          order: 9,
        });
      }
    }
    await ImportJobModel.updateOne(
      { _id },
      {
        $set: {
          status: 'importing',
          listId: list._id,
          'progress.processed': 0,
          totals: emptyImportTotals(),
        },
      },
    );
    started = performance.now();
    const result = await runImport(ids, deps);
    const job = await ImportJobModel.findById(_id).lean();
    console.info(
      `  import                             ${((performance.now() - started) / 1000).toFixed(1)} s  (${result.status}, created ${job?.totals.created ?? 0})`,
    );

    console.info('List queries (page of 20 + total, 20 runs each):');
    await timeQuery('all contacts', accountId, {});
    await timeQuery('search by name', accountId, { q: 'borrower 4999' });
    await timeQuery('search by phone digits', accountId, { q: '10004999' });
    await timeQuery('segment: dpd > 30 and loan ≥ ₹8,000', accountId, {
      conditions: [
        { key: 'dpd', op: 'gt', value: 30 },
        { key: 'loan_amount', op: 'gte', value: 8000 },
      ],
    });
    await timeQuery('list filter', accountId, { listIds: [list._id.toString()] });
  } finally {
    await ContactModel.deleteMany({ accountId });
    await ContactListModel.deleteMany({ accountId });
    await CustomFieldModel.deleteMany({ accountId });
    await ImportJobModel.deleteMany({ accountId });
    await AuditLogModel.deleteMany({ accountId }, { allowPurge: true });
    await RoleModel.deleteMany({ accountId });
    await AccountModel.deleteOne({ _id: accountId });
    rmSync(root, { recursive: true, force: true });
    await closeAllRedis();
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
