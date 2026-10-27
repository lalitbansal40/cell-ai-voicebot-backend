import { stringify } from 'csv-stringify/sync';
import type { Request } from 'express';
import { Types } from 'mongoose';
import writeXlsxFile from 'write-excel-file/node';

import { CAMPAIGN_LIMITS, CONTACT_LIMITS } from '../../config/limits';
import { storageKey, type StorageProvider } from '../../core/storage';
import { CallModel } from '../../db/models/call.model';
import {
  CampaignContactModel,
  type CampaignContactDoc,
} from '../../db/models/campaign-contact.model';
import { CampaignModel, type CampaignDoc } from '../../db/models/campaign.model';
import { CustomFieldModel } from '../../db/models/custom-field.model';
import {
  ExportJobModel,
  type ExportFormat,
  type ExportJobDoc,
} from '../../db/models/export-job.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { ConflictError } from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import { maskPhone } from '../../shared/utils/mask';
import { auditRequest, recordAudit } from '../audit/audit.service';
import { toPublicExport } from '../contact-exports/contact-exports.service';
import { safeCell } from '../contact-imports/error-report';
import { acquireJobLock, releaseJobLock } from '../contacts/locks';
import { createProgressReporter } from '../contacts/progress';

import { findCampaign } from './campaigns.service';

/** Where the API puts export jobs (the campaigns queue in production). */
export interface CampaignExportJobs {
  enqueue(data: { accountId: string; exportJobId: string }): Promise<void>;
}

export const unavailableCampaignExports: CampaignExportJobs = {
  enqueue: () => Promise.reject(new Error('Campaign export jobs are not configured for this app')),
};

/** Fixed columns (PHASE_8_PROMPT §1 "Export"); one column per snapshot variable follows. */
export const RESULT_HEADERS = [
  'Name',
  'Phone',
  'Status',
  'Attempts',
  'Last result',
  'Disposition',
  'Promise date',
  'Promise amount',
  'Callback',
  'Last call at (IST)',
  'Duration (s)',
  'Cost (₹)',
  'Skip reason',
  'Call id',
] as const;

const LOCK = 'campaign-export';

/** `POST /campaigns/:id/export` — phones in full only with `contacts.export`. */
export const createCampaignExport = async (
  req: Request,
  id: string,
  format: ExportFormat,
  jobs: CampaignExportJobs,
) => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  const campaign = await findCampaign(accountId, id);
  const total = await CampaignContactModel.countDocuments({ campaignId: campaign._id });
  if (total > CAMPAIGN_LIMITS.exportMaxRows) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `This campaign has ${String(total)} contacts — exports hold at most ${String(CAMPAIGN_LIMITS.exportMaxRows)}.`,
    );
  }
  const _id = new Types.ObjectId();
  if (!(await acquireJobLock(LOCK, accountId.toString(), _id.toString()))) {
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Another campaign export is running — wait for it to finish.',
    );
  }
  try {
    const job = await ExportJobModel.create({
      _id,
      accountId,
      kind: 'campaign_results',
      campaignId: campaign._id,
      format,
      includePhone: auth.permissions.has('contacts.export'),
      scope: 'campaign',
      filter: {},
      columns: [...RESULT_HEADERS],
      status: 'pending',
      progress: { processed: 0, total },
      createdBy: new Types.ObjectId(auth.userId),
    });
    await jobs.enqueue({ accountId: accountId.toString(), exportJobId: _id.toString() });
    await auditRequest(req, 'campaign.exported', {
      target: { type: 'campaign', id: campaign._id.toString() },
      meta: { format, includePhone: job.includePhone },
    });
    return toPublicExport(job.toObject({ transform: false }));
  } catch (err) {
    await releaseJobLock(LOCK, accountId.toString(), _id.toString());
    await ExportJobModel.deleteOne({ _id, status: 'pending' });
    throw err;
  }
};

const localDateTime = (at: Date, timezone: string) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(at)
    .replace(',', '');

/** One campaign contact → cells (text cells formula-safe; money via the ₹ formatter). */
export const resultRow = (
  cc: CampaignContactDoc,
  ctx: {
    includePhone: boolean;
    timezone: string;
    durations: Map<string, number | null>;
    variableKeys: string[];
  },
): string[] => {
  const callId = cc.lastCallId?.toString() ?? '';
  const duration = callId ? ctx.durations.get(callId) : null;
  const callback = cc.callback
    ? [cc.callback.date, cc.callback.time].filter(Boolean).join(' ')
    : '';
  return [
    safeCell(cc.name ?? ''),
    ctx.includePhone ? cc.phoneE164 : maskPhone(cc.phoneE164),
    cc.status,
    String(cc.attempts),
    cc.lastResult ?? '',
    cc.disposition ?? '',
    cc.promiseToPay?.date ?? '',
    typeof cc.promiseToPay?.amountMicros === 'number'
      ? formatInr(cc.promiseToPay.amountMicros)
      : '',
    callback,
    cc.lastAttemptAt ? localDateTime(cc.lastAttemptAt, ctx.timezone) : '',
    typeof duration === 'number' ? String(duration) : '',
    formatInr(cc.costMicros),
    cc.skipReason ?? '',
    callId,
    ...ctx.variableKeys.map((k) => safeCell(cc.variables[k] ?? '')),
  ];
};

/** CSV (BOM, CRLF) or XLSX (bold header) bytes of rows — shared by the record exports (Phase 14). */
export const exportFile = async (format: ExportFormat, records: string[][]): Promise<Buffer> => {
  if (format === 'csv') {
    return Buffer.concat([
      Buffer.from('﻿'),
      Buffer.from(stringify(records, { record_delimiter: '\r\n' })),
    ]);
  }
  return writeXlsxFile(
    records.map((row, i) =>
      row.map((value) => ({ value, ...(i === 0 ? { fontWeight: 'bold' as const } : {}) })),
    ),
  ).toBuffer();
};

/** The `campaign.export` job: rows in `seq` order → CSV / XLSX in storage; link valid 24 h. */
export const runCampaignExport = async (
  { accountId, exportJobId }: { accountId: string; exportJobId: string },
  { storage, logger }: { storage: StorageProvider; logger: Pick<Logger, 'warn'> },
): Promise<{ status: string; rows?: number }> => {
  const _id = new Types.ObjectId(exportJobId);
  const account = new Types.ObjectId(accountId);
  const job = await ExportJobModel.findOneAndUpdate(
    { _id, accountId: account, status: 'pending', kind: 'campaign_results' },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' },
  ).lean<ExportJobDoc>();
  if (!job) {
    await releaseJobLock(LOCK, accountId, exportJobId);
    return { status: 'skipped' };
  }
  const report = createProgressReporter(accountId, 'export.progress', { exportJobId });
  try {
    const campaign = await CampaignModel.findOne({
      _id: job.campaignId,
      accountId: account,
    }).lean<CampaignDoc>();
    if (!campaign) throw new Error('campaign_missing');
    const timezone = campaign.schedule.timezone;
    const total = await CampaignContactModel.countDocuments({ campaignId: campaign._id });
    const rows: CampaignContactDoc[] = [];
    let lastSeq = -1;
    report(0, total, 'processing', true);
    for (;;) {
      const page = await CampaignContactModel.find({
        campaignId: campaign._id,
        seq: { $gt: lastSeq },
      })
        .sort({ seq: 1 })
        .limit(CONTACT_LIMITS.exportBatchSize)
        .lean<CampaignContactDoc[]>();
      if (!page.length) break;
      rows.push(...page);
      lastSeq = page[page.length - 1]?.seq ?? lastSeq;
      await ExportJobModel.updateOne(
        { _id },
        { $set: { 'progress.processed': rows.length, 'progress.total': total } },
      );
      report(rows.length, total, 'processing');
    }
    // durations of the last calls; variable columns in first-seen order, labelled
    const calls = await CallModel.find({
      _id: { $in: rows.flatMap((r) => (r.lastCallId ? [r.lastCallId] : [])) },
    })
      .select({ durationSec: 1 })
      .lean<{ _id: Types.ObjectId; durationSec?: number | null }[]>();
    const durations = new Map(calls.map((c) => [c._id.toString(), c.durationSec ?? null]));
    // the name has its own column
    const variableKeys = [...new Set(rows.flatMap((r) => Object.keys(r.variables)))].filter(
      (k) => k !== 'name',
    );
    const fields = await CustomFieldModel.find({ accountId: account, key: { $in: variableKeys } })
      .select({ key: 1, label: 1 })
      .lean<{ key: string; label: string }[]>();
    const labels = new Map(fields.map((f) => [f.key, f.label]));
    const headers: string[] = [
      ...RESULT_HEADERS.map((h) =>
        h === 'Last call at (IST)' && timezone !== 'Asia/Kolkata'
          ? `Last call at (${timezone})`
          : h,
      ),
      ...variableKeys.map((k) => safeCell(labels.get(k) ?? k)),
    ];
    const ctx = { includePhone: job.includePhone, timezone, durations, variableKeys };
    const records = [headers, ...rows.map((r) => resultRow(r, ctx))];
    const ext = job.format;
    const fileKey = storageKey({ accountId, area: 'exports', id: exportJobId, ext });
    await storage.put(fileKey, await exportFile(job.format, records), {
      contentType:
        ext === 'csv'
          ? 'text/csv'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const now = new Date();
    await ExportJobModel.updateOne(
      { _id },
      {
        $set: {
          status: 'ready',
          fileKey,
          columns: headers,
          rowCount: rows.length,
          completedAt: now,
          expiresAt: new Date(now.getTime() + CONTACT_LIMITS.exportRetentionHours * 3_600_000),
          progress: { processed: rows.length, total },
        },
      },
    );
    await recordAudit({
      accountId: account,
      actor: { type: 'user', id: job.createdBy },
      action: 'campaign.exported',
      target: { type: 'campaign', id: campaign._id.toString() },
      meta: { format: job.format, rows: rows.length, includePhone: job.includePhone },
    });
    report(rows.length, total, 'ready', true);
    return { status: 'ready', rows: rows.length };
  } catch (err) {
    logger.warn(
      { exportJobId, err: err instanceof Error ? err.name : 'error' },
      'campaign: export failed',
    );
    await ExportJobModel.updateOne(
      { _id },
      { $set: { status: 'failed', errorMessage: 'The export failed — please try again.' } },
    );
    report(job.progress.processed, job.progress.total, 'failed', true);
    return { status: 'failed' };
  } finally {
    await releaseJobLock(LOCK, accountId, exportJobId);
  }
};
