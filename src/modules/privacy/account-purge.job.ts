import type { Types } from 'mongoose';
import mongoose from 'mongoose';

import type { StorageProvider } from '../../core/storage';
import { AccountModel, type AccountDoc } from '../../db/models/account.model';
import { UserModel } from '../../db/models/user.model';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { AppError, ConflictError } from '../../shared/errors/app-error';
import { getLogger } from '../../shared/logger';
import { recordAudit } from '../audit/audit.service';
import { revokeAllForUser } from '../auth/refresh.service';

import { eraseContactEverywhere } from './erase.service';

const BATCH = 200;

/** Records a business must keep. Their rows hold no contact data after the erase. */
export const PURGE_KEEP = new Set([
  'accounts',
  'auditLogs',
  'ledgerEntries',
  'invoices',
  'invoiceCounters',
  'wallets',
  'topupOrders',
  'paymentEvents',
  'statsDaily',
  'whatsappBillingDaily',
  'suppressions',
]);

/** Where a store keeps files that go with its rows. */
const FILE_FIELDS: Record<string, string[]> = {
  calls: ['recording.fileKey'],
  messages: ['media.storageKey'],
  inboxUploads: ['storageKey'],
  importJobs: ['fileKey', 'errorReportKey'],
  exportJobs: ['fileKey'],
  accountExports: ['fileKey'],
  flowAudio: ['fileKey'],
  knowledgeSources: ['fileKey'],
};

const db = () => mongoose.connection.db as NonNullable<typeof mongoose.connection.db>;

const valueAt = (doc: Record<string, unknown>, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
      doc,
    );

const removeStoreFiles = async (
  store: string,
  accountId: Types.ObjectId,
  storage: StorageProvider,
) => {
  const fields = FILE_FIELDS[store];
  if (!fields) return;
  for await (const doc of db()
    .collection(store)
    .find({ accountId } as never)) {
    for (const field of fields) {
      const key = valueAt(doc, field);
      if (typeof key === 'string') await storage.delete(key).catch(() => undefined);
    }
  }
};

export interface PurgeDeps {
  storage: StorageProvider;
  /** Disconnects a number through the WhatsApp service (unsubscribes it at Meta). */
  disconnectChannel?: (accountId: Types.ObjectId, channelId: string) => Promise<unknown>;
  /** Tests stop a run here. */
  afterContact?: () => void;
}

/**
 * Purges one account. Each step finds what is left, so a restart continues. Every query carries
 * this account's id. A contact on a live call waits for the next run.
 */
export const purgeAccount = async (
  accountId: Types.ObjectId,
  deps: PurgeDeps,
): Promise<{ status: 'purged' | 'waiting'; contacts: number }> => {
  // only an account an owner asked to delete, and never the platform's own
  const started = await AccountModel.updateOne(
    {
      _id: accountId,
      isPlatform: { $ne: true },
      'deletion.status': { $in: ['scheduled', 'purging'] },
    },
    { $set: { status: 'deleted', 'deletion.status': 'purging' } },
  );
  if (started.matchedCount === 0) {
    throw new ConflictError('CONFLICT_INVALID_STATE', 'This account is not waiting to be deleted.');
  }
  const users = await UserModel.find({ accountId })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  await UserModel.updateMany(
    { accountId },
    { $set: { status: 'disabled' }, $inc: { tokenVersion: 1 } },
  );
  for (const user of users) await revokeAllForUser(user._id, 'account_deleted');

  const channels = await WhatsAppChannelModel.find({
    accountId,
    status: { $ne: 'disconnected' },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();
  for (const channel of channels) {
    try {
      await deps.disconnectChannel?.(accountId, channel._id.toString());
    } catch (err) {
      // the rows go anyway; Meta stops once the app is removed from the WABA by hand
      getLogger().warn(
        { channelId: channel._id.toString(), err: (err as Error).name },
        'privacy: number not disconnected at Meta during purge',
      );
    }
  }

  let contacts = 0;
  let waiting = false;
  let after: Types.ObjectId | null = null;
  for (;;) {
    const page: { _id: Types.ObjectId }[] = await db()
      .collection('contacts')
      .find((after ? { accountId, _id: { $gt: after } } : { accountId }) as never)
      .project<{ _id: Types.ObjectId }>({ _id: 1 })
      .sort({ _id: 1 })
      .limit(BATCH)
      .toArray();
    for (const row of page) {
      try {
        await eraseContactEverywhere(accountId, row._id, deps.storage);
        contacts += 1;
      } catch (err) {
        if (err instanceof AppError && err.code === 'CONTACT_ERASE_BLOCKED') waiting = true;
        else if (!(err instanceof AppError && err.status === 404)) throw err;
      }
      deps.afterContact?.();
    }
    const last = page.at(-1);
    if (!last) break;
    after = last._id;
  }
  if (waiting) return { status: 'waiting', contacts };

  const collections = await db().listCollections().toArray();
  for (const { name } of collections) {
    if (PURGE_KEEP.has(name) || name.startsWith('system.') || name === 'migrations') continue;
    await removeStoreFiles(name, accountId, deps.storage);
    await db().collection(name).deleteMany({ accountId });
  }

  const tombstone = `deleted-${accountId.toString()}`;
  await AccountModel.collection.updateOne(
    { _id: accountId },
    {
      $set: {
        name: 'Deleted account',
        slug: tombstone,
        status: 'deleted',
        ownerId: null,
        billing: null,
        'deletion.status': 'purged',
        'deletion.purgedAt': new Date(),
      },
    },
  );
  await recordAudit({
    accountId,
    actor: { type: 'system', id: null },
    action: 'account.purged',
    target: { type: 'account', id: accountId.toString() },
    meta: { contacts },
  });
  return { status: 'purged', contacts };
};

/** Maintenance `account-purge` (hourly): accounts past their grace, and runs that stopped. */
export const runAccountPurges = async (
  deps: PurgeDeps,
  now: Date = new Date(),
): Promise<{ purged: number; waiting: number }> => {
  const due = await AccountModel.find({
    isPlatform: { $ne: true },
    $or: [
      { 'deletion.status': 'scheduled', 'deletion.scheduledFor': { $lte: now } },
      { 'deletion.status': 'purging' },
    ],
  })
    .select({ _id: 1 })
    .lean<Pick<AccountDoc, '_id'>[]>();
  let purged = 0;
  let waiting = 0;
  for (const account of due) {
    const res = await purgeAccount(account._id, deps);
    if (res.status === 'purged') purged += 1;
    else waiting += 1;
  }
  return { purged, waiting };
};
