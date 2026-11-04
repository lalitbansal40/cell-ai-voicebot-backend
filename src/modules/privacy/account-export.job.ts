import { once } from 'node:events';
import { PassThrough } from 'node:stream';

import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import mongoose, { Types } from 'mongoose';

import { getEnv } from '../../config/env';
import { getEmail } from '../../core/email';
import type { ContactJobContext } from '../../core/queues/workers/contacts.worker';
import { storageKey } from '../../core/storage';
import { AccountExportModel, type AccountExportDoc } from '../../db/models/account-export.model';
import { AccountModel } from '../../db/models/account.model';
import { UserModel } from '../../db/models/user.model';
import type { ContactJobData } from '../contacts/jobs';
import { notify } from '../notifications/notifications.service';

import { maskTextValues, readContactVariables } from './sensitive';

/** The stores marked "yes" in DATA_MAP.md; a test keeps the two the same. */
export const EXPORT_STORES = [
  'accounts',
  'users',
  'auditLogs',
  'contactLists',
  'customFieldDefinitions',
  'segments',
  'dndEntries',
  'sheetImports',
  'calls',
  'transcriptTurns',
  'callInsights',
  'aiAgents',
  'knowledgeBases',
  'knowledgeSources',
  'knowledgeChunks',
  'flows',
  'flowVersions',
  'flowAudio',
  'campaigns',
  'campaignContacts',
  'whatsappCampaigns',
  'whatsappCampaignRecipients',
  'conversations',
  'messages',
  'conversationSummaries',
  'postCallMessages',
  'outcomeRules',
  'whatsappCallPermissions',
  'whatsappChannels',
  'whatsappTemplates',
  'webhookEndpoints',
  'wallets',
  'ledgerEntries',
  'invoices',
  'topupOrders',
  'statsDaily',
] as const;

export const ACCOUNT_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Field names that never leave: secrets and anything that can sign in. */
const SECRET_FIELD =
  /sealed|secret|password|token|invite|keyhash|mfa|pinsealed|codehash|headers|^url$|^embedding$/i;

/** A document without secrets. Sealed text of a queued message stays masked. */
export const cleanForExport = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cleanForExport);
  if (value instanceof Types.ObjectId || value instanceof Date) return value;
  if (typeof value === 'string') return maskTextValues({ v: value }).v;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_FIELD.test(key))
        .map(([key, item]) => [key, cleanForExport(item)]),
    );
  }
  return value;
};

const csvCell = (value: string): string => {
  // a cell starting like a formula stays text in a spreadsheet
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const db = () => mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;

interface ExportContact {
  phoneE164?: string;
  name?: string | null;
  email?: string | null;
  externalId?: string | null;
  tags?: string[];
  variables?: Record<string, unknown>;
  deletedAt?: Date | null;
}

/** Streams the archive: rows are read one at a time, so memory stays flat with any size. */
const buildArchive = async (
  job: AccountExportDoc,
  out: PassThrough,
  ctx: Pick<ContactJobContext, 'storage'>,
): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      out.destroy(err);
      return;
    }
    out.write(chunk);
    if (final) out.end();
  });
  const drain = async () => {
    if (out.writableNeedDrain) await once(out, 'drain');
  };
  const encoder = new TextEncoder();

  const contacts = new ZipDeflate('contacts.csv', { level: 6 });
  zip.add(contacts);
  contacts.push(encoder.encode('phone,name,email,external_id,tags,fields\r\n'));
  let rows = 0;
  for await (const c of db()
    .collection<ExportContact>('contacts')
    .find({ accountId: job.accountId, deletedAt: null } as never)) {
    const line = [
      c.phoneE164 ?? '',
      csvCell(c.name ?? ''),
      csvCell(c.email ?? ''),
      csvCell(c.externalId ?? ''),
      csvCell((c.tags ?? []).join(' ')),
      // the owner's own export is the one place sensitive fields are opened in a file
      csvCell(JSON.stringify(readContactVariables(c, { purpose: 'export' }))),
    ].join(',');
    contacts.push(encoder.encode(`${line}\r\n`));
    rows += 1;
    if (rows % 500 === 0) await drain();
  }
  contacts.push(new Uint8Array(0), true);
  counts.contacts = rows;

  for (const store of EXPORT_STORES) {
    const file = new ZipDeflate(`${store}.jsonl`, { level: 6 });
    zip.add(file);
    const filter = store === 'accounts' ? { _id: job.accountId } : { accountId: job.accountId };
    let n = 0;
    for await (const doc of db()
      .collection(store)
      .find(filter as never)) {
      file.push(encoder.encode(`${JSON.stringify(cleanForExport(doc))}\n`));
      n += 1;
      if (n % 500 === 0) await drain();
    }
    file.push(new Uint8Array(0), true);
    counts[store] = n;
  }

  if (job.includeRecordings) {
    let recordings = 0;
    for await (const call of db()
      .collection<{ _id: Types.ObjectId; recording?: { fileKey?: string } | null }>('calls')
      .find({ accountId: job.accountId, 'recording.fileKey': { $type: 'string' } } as never)
      .project<{ _id: Types.ObjectId; recording: { fileKey: string } }>({ recording: 1 })) {
      let stream: AsyncIterable<Buffer>;
      try {
        stream = (await ctx.storage.get(call.recording.fileKey)) as AsyncIterable<Buffer>;
      } catch {
        continue; // removed by retention meanwhile
      }
      const file = new ZipPassThrough(`recordings/${call._id.toString()}.wav`);
      zip.add(file);
      for await (const chunk of stream) {
        file.push(new Uint8Array(chunk));
        await drain();
      }
      file.push(new Uint8Array(0), true);
      recordings += 1;
    }
    counts.recordings = recordings;
  }
  zip.end();
  return counts;
};

/** `account.export` — one streamed zip into storage; the owner gets a notification and an e-mail. */
export const runAccountExport = async (
  { accountId, accountExportId }: ContactJobData['account.export'],
  ctx: Pick<ContactJobContext, 'storage'>,
): Promise<{ status: string }> => {
  const account = new Types.ObjectId(accountId);
  const job = await AccountExportModel.findOne({
    _id: accountExportId,
    accountId: account,
  }).lean<AccountExportDoc>();
  if (!job || job.status === 'ready' || job.status === 'expired') return { status: 'skipped' };
  await AccountExportModel.updateOne(
    { _id: job._id },
    { $set: { status: 'running', error: null } },
  );
  const key = storageKey({
    accountId,
    area: 'account-exports',
    id: job._id.toString(),
    ext: 'zip',
  });
  try {
    const out = new PassThrough({ highWaterMark: 1024 * 1024 });
    const saving = ctx.storage.put(key, out, { contentType: 'application/zip' });
    const [counts, saved] = await Promise.all([buildArchive(job, out, ctx), saving]);
    const now = new Date();
    await AccountExportModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: 'ready',
          fileKey: saved.key,
          sizeBytes: saved.size,
          counts,
          expiresAt: new Date(now.getTime() + ACCOUNT_EXPORT_TTL_MS),
        },
      },
    );
  } catch (err) {
    await AccountExportModel.updateOne(
      { _id: job._id },
      { $set: { status: 'failed', error: 'The export could not be finished.' } },
    );
    throw err;
  }
  const link = '/settings/account';
  await notify({
    accountId: account,
    userIds: [job.requestedBy],
    type: 'account.export_ready',
    title: 'Your data export is ready',
    body: 'Download it within 7 days.',
    link,
  });
  const [owner, info] = await Promise.all([
    UserModel.findById(job.requestedBy).select({ email: 1 }).lean<{ email: string }>(),
    AccountModel.findById(account).select({ name: 1 }).lean<{ name: string }>(),
  ]);
  if (owner) {
    await getEmail().enqueue('account.export_ready', owner.email, {
      accountName: info?.name ?? 'Your account',
      url: `${getEnv().FRONTEND_URL}${link}`,
    });
  }
  return { status: 'ready' };
};

/** Maintenance `account-exports-cleanup` (daily): files older than 7 days are removed. */
export const cleanupAccountExports = async (
  storage: ContactJobContext['storage'],
  now: Date = new Date(),
): Promise<{ removed: number }> => {
  const due = await AccountExportModel.find({ status: 'ready', expiresAt: { $lte: now } })
    .select({ fileKey: 1 })
    .lean<{ _id: Types.ObjectId; fileKey: string | null }[]>();
  for (const row of due) {
    if (row.fileKey) await storage.delete(row.fileKey).catch(() => undefined);
    await AccountExportModel.updateOne(
      { _id: row._id },
      { $set: { status: 'expired', fileKey: null } },
    );
  }
  return { removed: due.length };
};
