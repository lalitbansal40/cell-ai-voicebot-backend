/**
 * Phase 14 exports (CSV / XLSX, the Phase 3 / 8 export-job pipeline): calls (the calls
 * list filters; phones in full only with `contacts.export`; AI summaries on request),
 * WhatsApp message metadata (never the text), and a report tab's numbers. One export
 * at a time per account, ≤ `REPORT_LIMITS.exportMaxRows`, file kept 24 h, file names
 * without personal data.
 */
import type { Request } from 'express';
import { Types } from 'mongoose';
import type { z } from 'zod';

import { CONTACT_LIMITS, REPORT_LIMITS } from '../../config/limits';
import { storageKey, type StorageProvider } from '../../core/storage';
import { AccountModel } from '../../db/models/account.model';
import { AiAgentModel } from '../../db/models/ai-agent.model';
import { CallInsightModel } from '../../db/models/call-insight.model';
import { CallModel, type CallDoc } from '../../db/models/call.model';
import { CampaignModel } from '../../db/models/campaign.model';
import { ContactModel } from '../../db/models/contact.model';
import {
  ExportJobModel,
  type ExportJobDoc,
  type ExportKind,
} from '../../db/models/export-job.model';
import { FlowModel } from '../../db/models/flow.model';
import { MessageModel, type MessageDoc } from '../../db/models/message.model';
import { UserModel } from '../../db/models/user.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter, toObjectId } from '../../shared/auth/tenant';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../shared/errors/app-error';
import type { Logger } from '../../shared/logger';
import { formatInr } from '../../shared/money';
import { addDays, formatDateTimeInZone, startOfDayInZone } from '../../shared/time';
import { maskPhone } from '../../shared/utils/mask';
import { auditRequest } from '../audit/audit.service';
import { callsFilter } from '../calls/calls.service';
import { exportFile } from '../campaigns/export';
import { safeCell } from '../contact-imports/error-report';
import type { ContactJobs } from '../contacts/jobs';
import { acquireJobLock, releaseJobLock } from '../contacts/locks';
import { createProgressReporter } from '../contacts/progress';
import { ReportQuery } from '../reports/reports.schema';
import { buildReport, reportContext } from '../reports/reports.service';
import { accountTimezone } from '../wallet/wallet.service';

import type {
  ExportCallsBody,
  ExportMessagesBody,
  ExportReportBody,
} from './record-exports.schema';

const LOCK = 'records-export';
const BATCH = 1_000;
const RECORD_KINDS: ExportKind[] = ['calls', 'messages', 'report'];
const NEEDS: Partial<Record<ExportKind, string>> = {
  calls: 'calls.export',
  messages: 'reports.export',
  report: 'reports.export',
};

const iso = (d?: Date | null) => (d ? d.toISOString() : null);

export const toRecordExport = (job: ExportJobDoc, downloadUrl?: string) => ({
  id: job._id.toString(),
  kind: job.kind,
  format: job.format,
  status: job.status,
  progress: { processed: job.progress.processed, total: job.progress.total },
  rowCount: job.rowCount,
  errorMessage: job.errorMessage ?? null,
  completedAt: iso(job.completedAt),
  expiresAt: iso(job.expiresAt),
  createdAt: job.createdAt.toISOString(),
  ...(downloadUrl ? { downloadUrl } : {}),
});

/** Days (account timezone) → `createdAt` / `at` bounds. */
const dayBounds = (timezone: string, from?: string, to?: string) => ({
  ...(from ? { $gte: startOfDayInZone(from, timezone) } : {}),
  ...(to ? { $lt: startOfDayInZone(addDays(to, 1), timezone) } : {}),
});

const callsQuery = async (accountId: Types.ObjectId, body: z.infer<typeof ExportCallsBody>) => {
  const timezone = await accountTimezone(accountId);
  const { from, to, format: _f, includePhone: _p, includeSummary: _s, ...rest } = body;
  const filter = await callsFilter(accountId, rest);
  const at = dayBounds(timezone, from, to);
  if (Object.keys(at).length) filter.createdAt = at;
  return filter;
};

const messagesQuery = async (
  accountId: Types.ObjectId,
  body: z.infer<typeof ExportMessagesBody>,
) => {
  const timezone = await accountTimezone(accountId);
  return {
    accountId,
    type: { $ne: 'note' },
    at: dayBounds(timezone, body.from, body.to),
    ...(body.channelId ? { channelId: new Types.ObjectId(body.channelId) } : {}),
    ...(body.direction ? { direction: body.direction } : {}),
  };
};

const start = async (
  req: Request,
  input: {
    kind: ExportKind;
    format: ExportJobDoc['format'];
    total: number;
    filter: Record<string, unknown>;
    includePhone?: boolean;
    includeSummary?: boolean;
  },
  jobs: ContactJobs,
) => {
  const auth = requireAuth(req);
  const { accountId } = tenantFilter(req);
  if (input.total > REPORT_LIMITS.exportMaxRows)
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      `This export would have ${String(input.total)} rows — narrow it to at most ${String(REPORT_LIMITS.exportMaxRows)}.`,
    );
  const _id = new Types.ObjectId();
  if (!(await acquireJobLock(LOCK, accountId.toString(), _id.toString())))
    throw new ConflictError(
      'CONFLICT_INVALID_STATE',
      'Another export is running — wait for it to finish.',
    );
  try {
    const job = await ExportJobModel.create({
      _id,
      accountId,
      kind: input.kind,
      format: input.format,
      includePhone: input.includePhone ?? false,
      includeSummary: input.includeSummary ?? false,
      scope: 'records',
      filter: input.filter,
      columns: [],
      status: 'pending',
      progress: { processed: 0, total: input.total },
      createdBy: new Types.ObjectId(auth.userId),
    });
    await jobs.enqueue('records.export', {
      accountId: accountId.toString(),
      exportJobId: _id.toString(),
    });
    await auditRequest(req, 'report.exported', {
      meta: {
        kind: input.kind,
        format: input.format,
        rows: input.total,
        includePhone: input.includePhone ?? false,
        includeSummary: input.includeSummary ?? false,
      },
    });
    return toRecordExport(job.toObject({ transform: false }));
  } catch (err) {
    await releaseJobLock(LOCK, accountId.toString(), _id.toString());
    await ExportJobModel.deleteOne({ _id, status: 'pending' });
    throw err;
  }
};

export const createCallsExport = async (
  req: Request,
  body: z.infer<typeof ExportCallsBody>,
  jobs: ContactJobs,
) => {
  const auth = requireAuth(req);
  if (body.includePhone && !auth.permissions.has('contacts.export'))
    throw new ForbiddenError('Full phone numbers need the contacts export permission.');
  const { accountId } = tenantFilter(req);
  const query = await callsQuery(accountId, body);
  return start(
    req,
    {
      kind: 'calls',
      format: body.format,
      total: await CallModel.countDocuments(query),
      filter: { body },
      includePhone: body.includePhone,
      includeSummary: body.includeSummary,
    },
    jobs,
  );
};

export const createMessagesExport = async (
  req: Request,
  body: z.infer<typeof ExportMessagesBody>,
  jobs: ContactJobs,
) => {
  const { accountId } = tenantFilter(req);
  const total = await MessageModel.countDocuments((await messagesQuery(accountId, body)) as never);
  return start(req, { kind: 'messages', format: body.format, total, filter: { body } }, jobs);
};

export const createReportExport = async (
  req: Request,
  body: z.infer<typeof ExportReportBody>,
  jobs: ContactJobs,
) => {
  const { accountId } = tenantFilter(req);
  // fails now (422) on a bad range instead of in the job
  await reportContext(accountId, ReportQuery.parse(body.query));
  return start(req, { kind: 'report', format: body.format, total: 1, filter: { body } }, jobs);
};

/** `calls-<accountSlug>-<from>-<to>.csv`, `report-calls-<slug>-…` — no personal data. */
export const downloadNameOf = (
  job: Pick<ExportJobDoc, 'kind' | 'format' | 'filter'>,
  slug: string,
) => {
  const body = (job.filter as { body?: Record<string, unknown> }).body ?? {};
  const range =
    (job.kind === 'report' ? (body.query as Record<string, unknown> | undefined) : body) ?? {};
  const from = typeof range.from === 'string' ? range.from : 'start';
  const to = typeof range.to === 'string' ? range.to : 'now';
  const kind =
    job.kind === 'report'
      ? `report-${typeof body.tab === 'string' ? body.tab : 'overview'}`
      : job.kind;
  return `${kind}-${slug}-${from}-${to}.${job.format}`;
};

/** The kinds this person may see: calls with `calls.export`, messages / reports with `reports.export`. */
const visibleKinds = (req: Request): ExportKind[] => {
  const perms = requireAuth(req).permissions;
  return RECORD_KINDS.filter((k) => perms.has(NEEDS[k] ?? 'reports.export'));
};

/** `GET /exports` — recent record exports, newest first. */
export const listRecordExports = async (req: Request, q: { page: number; limit: number }) => {
  const filter = {
    ...tenantFilter(req),
    kind: { $in: visibleKinds(req) },
    ...(!requireAuth(req).permissions.has('contacts.export')
      ? { includePhone: { $ne: true } }
      : {}),
  };
  const [jobs, total] = await Promise.all([
    ExportJobModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .lean<ExportJobDoc[]>(),
    ExportJobModel.countDocuments(filter),
  ]);
  return {
    items: jobs.map((j) => toRecordExport(j)),
    meta: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) },
  };
};

export const getRecordExport = async (req: Request, id: string, storage: StorageProvider) => {
  const _id = toObjectId(id);
  const job = _id
    ? await ExportJobModel.findOne({
        _id,
        ...tenantFilter(req),
        kind: { $in: RECORD_KINDS },
      }).lean<ExportJobDoc>()
    : null;
  if (!job) throw new NotFoundError('Export not found');
  if (!visibleKinds(req).includes(job.kind)) throw new NotFoundError('Export not found');
  if (job.includePhone && !requireAuth(req).permissions.has('contacts.export'))
    throw new NotFoundError('Export not found');
  const ready =
    job.status === 'ready' && job.fileKey && job.expiresAt && job.expiresAt > new Date();
  const slug = ready
    ? ((await AccountModel.findById(job.accountId).select({ slug: 1 }).lean<{ slug: string }>())
        ?.slug ?? 'account')
    : '';
  const url = ready
    ? await storage.signedUrl(job.fileKey as string, {
        expiresInSec: CONTACT_LIMITS.exportUrlTtlSec,
        downloadName: downloadNameOf(job, slug),
      })
    : undefined;
  return toRecordExport(job, url);
};

// ── Rows ────────────────────────────────────────────────────────────────────

const names = async <T extends { _id: Types.ObjectId }>(
  find: () => Promise<T[]>,
  label: (row: T) => string,
): Promise<Map<string, string>> => new Map((await find()).map((r) => [r._id.toString(), label(r)]));

const idsOf = (values: (Types.ObjectId | null | undefined)[]) =>
  [...new Set(values.filter((v): v is Types.ObjectId => Boolean(v)).map(String))].map(
    (id) => new Types.ObjectId(id),
  );

export const CALL_HEADERS = [
  'Date',
  'Direction',
  'Line',
  'WhatsApp number',
  'Contact',
  'Phone',
  'Status',
  'Length (s)',
  'Outcome',
  'Outcome set by',
  'Customer mood',
  'Promise date',
  'Promise amount',
  'Flow / agent',
  'Campaign',
  'Answered by',
  'Cost',
  'Call id',
] as const;

const callRowsOf = async (
  accountId: Types.ObjectId,
  calls: CallDoc[],
  options: { timezone: string; includePhone: boolean; includeSummary: boolean },
): Promise<string[][]> => {
  const contacts = await ContactModel.find({
    accountId,
    _id: { $in: idsOf(calls.map((c) => c.contactId)) },
  })
    .select({ name: 1, phoneE164: 1 })
    .lean<{ _id: Types.ObjectId; name: string | null; phoneE164: string }[]>();
  const contactOf = new Map(contacts.map((c) => [c._id.toString(), c]));
  const [channels, users, flows, agents, campaigns] = await Promise.all([
    names(
      () =>
        WhatsAppChannelModel.find({
          accountId,
          _id: { $in: idsOf(calls.map((c) => c.whatsapp?.channelId)) },
        })
          .select({ label: 1 })
          .lean<{ _id: Types.ObjectId; label: string }[]>(),
      (r) => r.label,
    ),
    names(
      () =>
        UserModel.find({
          accountId,
          _id: { $in: idsOf(calls.map((c) => c.whatsapp?.answeredBy ?? c.agentUserId)) },
        })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>(),
      (r) => r.name,
    ),
    names(
      () =>
        FlowModel.find({ accountId, _id: { $in: idsOf(calls.map((c) => c.source.flowId)) } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>(),
      (r) => r.name,
    ),
    names(
      () =>
        AiAgentModel.find({ accountId, _id: { $in: idsOf(calls.map((c) => c.source.agentId)) } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>(),
      (r) => r.name,
    ),
    names(
      () =>
        CampaignModel.find({ accountId, _id: { $in: idsOf(calls.map((c) => c.campaignId)) } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>(),
      (r) => r.name,
    ),
  ]);
  const summaries = new Map<
    string,
    { summary: string; promiseDate: string | null; promiseAmountMicros: number | null }
  >();
  const done = await CallInsightModel.find({
    accountId,
    callId: { $in: calls.map((c) => c._id) },
    status: 'done',
  })
    .sort({ version: 1 })
    .select({ callId: 1, output: 1 })
    .lean<
      {
        callId: Types.ObjectId;
        output: {
          summary: string;
          keyInfo: { promiseDate: string | null; promiseAmountMicros: number | null };
        } | null;
      }[]
    >();
  for (const d of done)
    if (d.output)
      summaries.set(d.callId.toString(), {
        summary: d.output.summary,
        promiseDate: d.output.keyInfo.promiseDate,
        promiseAmountMicros: d.output.keyInfo.promiseAmountMicros,
      });
  return calls.map((c) => {
    const contact = c.contactId ? contactOf.get(c.contactId.toString()) : undefined;
    const phone = contact?.phoneE164 ?? '';
    const insight = summaries.get(c._id.toString());
    const program = c.source.flowId
      ? flows.get(c.source.flowId.toString())
      : c.source.agentId
        ? agents.get(c.source.agentId.toString())
        : undefined;
    const by = c.whatsapp?.answeredBy ?? c.agentUserId;
    const row = [
      formatDateTimeInZone(c.createdAt, options.timezone),
      c.direction,
      c.provider,
      c.whatsapp ? (channels.get(c.whatsapp.channelId.toString()) ?? '') : '',
      safeCell(contact?.name ?? ''),
      phone ? (options.includePhone ? phone : maskPhone(phone)) : '',
      c.status,
      String(Math.round(c.durationSec)),
      safeCell(c.disposition ?? ''),
      c.dispositionSource ?? '',
      c.insights?.sentiment ?? '',
      insight?.promiseDate ?? '',
      typeof insight?.promiseAmountMicros === 'number'
        ? formatInr(insight.promiseAmountMicros)
        : '',
      safeCell(program ?? ''),
      safeCell(c.campaignId ? (campaigns.get(c.campaignId.toString()) ?? '') : ''),
      safeCell(by ? (users.get(by.toString()) ?? '') : ''),
      formatInr(c.cost.totalMicros),
      c._id.toString(),
    ];
    if (options.includeSummary) row.push(safeCell(insight?.summary ?? ''));
    return row;
  });
};

export const MESSAGE_HEADERS = [
  'Date',
  'Direction',
  'Type',
  'Status',
  'Template',
  'WhatsApp number',
  'Team member',
  'Conversation id',
  'Message id',
] as const;

const messageRowsOf = async (
  accountId: Types.ObjectId,
  messages: MessageDoc[],
  timezone: string,
): Promise<string[][]> => {
  const [channels, users] = await Promise.all([
    names(
      () =>
        WhatsAppChannelModel.find({
          accountId,
          _id: { $in: idsOf(messages.map((m) => m.channelId)) },
        })
          .select({ label: 1 })
          .lean<{ _id: Types.ObjectId; label: string }[]>(),
      (r) => r.label,
    ),
    names(
      () =>
        UserModel.find({ accountId, _id: { $in: idsOf(messages.map((m) => m.sentBy)) } })
          .select({ name: 1 })
          .lean<{ _id: Types.ObjectId; name: string }[]>(),
      (r) => r.name,
    ),
  ]);
  return messages.map((m) => [
    formatDateTimeInZone(m.at, timezone),
    m.direction,
    m.type,
    m.status,
    m.template ? safeCell(`${m.template.name} (${m.template.language})`) : '',
    safeCell(channels.get(m.channelId.toString()) ?? ''),
    safeCell(m.sentBy ? (users.get(m.sentBy.toString()) ?? '') : ''),
    m.conversationId.toString(),
    m._id.toString(),
  ]);
};

const cell = (value: number | null | undefined, unit: string): string => {
  if (value === null || value === undefined) return '';
  if (unit === 'micros') return formatInr(value);
  if (unit === 'percent') return `${String(value)}%`;
  return String(value);
};

/** A report tab → rows: the KPIs (value, previous), an empty row, the table. */
const reportRows = async (
  accountId: Types.ObjectId,
  body: z.infer<typeof ExportReportBody>,
): Promise<string[][]> => {
  const report = await buildReport(
    body.tab,
    await reportContext(accountId, ReportQuery.parse(body.query)),
  );
  const rows: string[][] = [
    ['Report', body.tab, `${report.range.from} – ${report.range.to}`, report.range.timezone],
    ['Metric', 'Value', 'Previous period'],
    ...report.kpis.map((k) => [k.key, cell(k.value, k.unit), cell(k.previous, k.unit)]),
  ];
  if (report.table.columns.length) {
    rows.push([], ['Name', ...report.table.columns.map((c) => c.key)]);
    for (const r of report.table.rows)
      rows.push([
        safeCell(r.label),
        ...report.table.columns.map((c) => cell(r.values[c.key], c.unit)),
      ]);
  }
  return rows;
};

type PageRow = { _id: Types.ObjectId; createdAt: Date; at: Date };

/** The `records.export` job (contacts queue). */
export const runRecordExport = async (
  { accountId, exportJobId }: { accountId: string; exportJobId: string },
  { storage, logger }: { storage?: StorageProvider; logger: Pick<Logger, 'warn'> },
): Promise<{ status: string; rows?: number }> => {
  const _id = new Types.ObjectId(exportJobId);
  const account = new Types.ObjectId(accountId);
  const job = await ExportJobModel.findOneAndUpdate(
    { _id, accountId: account, status: 'pending', kind: { $in: RECORD_KINDS } },
    { $set: { status: 'processing' } },
    { returnDocument: 'after' },
  ).lean<ExportJobDoc>();
  if (!job) {
    await releaseJobLock(LOCK, accountId, exportJobId);
    return { status: 'skipped' };
  }
  const report = createProgressReporter(accountId, 'export.progress', { exportJobId });
  try {
    if (!storage) throw new AppError('PROVIDER_UNAVAILABLE', 'File storage is not configured.');
    const timezone = await accountTimezone(account);
    const body = (job.filter as { body: unknown }).body;
    let records: string[][];
    if (job.kind === 'report') {
      records = await reportRows(account, body as z.infer<typeof ExportReportBody>);
    } else {
      const query =
        job.kind === 'calls'
          ? await callsQuery(account, body as z.infer<typeof ExportCallsBody>)
          : await messagesQuery(account, body as z.infer<typeof ExportMessagesBody>);
      const model = (job.kind === 'calls'
        ? CallModel
        : MessageModel) as unknown as typeof CallModel;
      const timeField = job.kind === 'calls' ? 'createdAt' : 'at';
      const headers: string[] =
        job.kind === 'calls'
          ? [...CALL_HEADERS, ...(job.includeSummary ? ['AI summary'] : [])]
          : [...MESSAGE_HEADERS];
      records = [headers];
      let cursor: { at: Date; id: Types.ObjectId } | null = null;
      for (;;) {
        const page = await model
          .find({
            ...query,
            ...(cursor
              ? {
                  $or: [
                    { [timeField]: { $gt: cursor.at } },
                    { [timeField]: cursor.at, _id: { $gt: cursor.id } },
                  ],
                }
              : {}),
          } as never)
          .sort({ [timeField]: 1, _id: 1 })
          .limit(BATCH)
          .lean<PageRow[]>();
        if (!page.length) break;
        if (records.length - 1 + page.length > REPORT_LIMITS.exportMaxRows)
          throw new ConflictError(
            'CONFLICT_INVALID_STATE',
            `This export exceeds ${String(REPORT_LIMITS.exportMaxRows)} rows. Narrow the filters and try again.`,
          );
        records.push(
          ...(job.kind === 'calls'
            ? await callRowsOf(account, page as unknown as CallDoc[], {
                timezone,
                includePhone: job.includePhone,
                includeSummary: job.includeSummary ?? false,
              })
            : await messageRowsOf(account, page as unknown as MessageDoc[], timezone)),
        );
        const last = page[page.length - 1] as PageRow;
        cursor = { at: job.kind === 'calls' ? last.createdAt : last.at, id: last._id };
        await ExportJobModel.updateOne(
          { _id },
          { $set: { 'progress.processed': records.length - 1 } },
        );
        report(records.length - 1, job.progress.total, 'processing');
      }
    }
    const fileKey = storageKey({ accountId, area: 'exports', id: exportJobId, ext: job.format });
    await storage.put(fileKey, await exportFile(job.format, records), {
      contentType:
        job.format === 'csv'
          ? 'text/csv'
          : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const rows = job.kind === 'report' ? records.length : records.length - 1;
    const now = new Date();
    await ExportJobModel.updateOne(
      { _id },
      {
        $set: {
          status: 'ready',
          fileKey,
          columns: records[job.kind === 'report' ? 1 : 0] ?? [],
          rowCount: rows,
          completedAt: now,
          expiresAt: new Date(now.getTime() + CONTACT_LIMITS.exportRetentionHours * 3_600_000),
          progress: { processed: rows, total: rows },
        },
      },
    );
    report(rows, rows, 'ready', true);
    return { status: 'ready', rows };
  } catch (err) {
    logger.warn(
      { exportJobId, err: err instanceof Error ? err.name : 'error' },
      'records: export failed',
    );
    await ExportJobModel.updateOne(
      { _id },
      {
        $set: {
          status: 'failed',
          errorMessage:
            err instanceof ConflictError ? err.message : 'The export failed — please try again.',
        },
      },
    );
    report(job.progress.processed, job.progress.total, 'failed', true);
    return { status: 'failed' };
  } finally {
    await releaseJobLock(LOCK, accountId, exportJobId);
  }
};
