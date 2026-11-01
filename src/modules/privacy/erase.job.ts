import { Types } from 'mongoose';

import type { ContactJobContext } from '../../core/queues/workers/contacts.worker';
import { notifyAccount } from '../../core/realtime/notify';
import { EraseJobModel, type EraseJobDoc } from '../../db/models/erase-job.model';
import { AppError, NotFoundError } from '../../shared/errors/app-error';
import type { ContactJobData } from '../contacts/jobs';
import { notify } from '../notifications/notifications.service';

import { eraseContactEverywhere } from './erase.service';

export const ERASE_RETRY_DELAY_MS = 60_000;

/**
 * `contacts.erase` — erases a list of contacts. It works from the ids still on the job, so a
 * restart continues. A contact on a live call is tried again by a later run.
 */
export const runEraseJob = async (
  { accountId, eraseJobId }: ContactJobData['contacts.erase'],
  ctx: Pick<ContactJobContext, 'storage' | 'jobs'>,
): Promise<{ done: number; retried: number; skipped?: true }> => {
  const account = new Types.ObjectId(accountId);
  const job = await EraseJobModel.findOne({
    _id: eraseJobId,
    accountId: account,
  }).lean<EraseJobDoc>();
  if (!job || job.status === 'done') return { done: 0, retried: 0, skipped: true };
  await EraseJobModel.updateOne({ _id: job._id }, { $set: { status: 'running' } });
  const blocked: Types.ObjectId[] = [];
  const counts = { ...job.counts };
  let done = job.done;
  for (const contactId of job.contactIds) {
    try {
      const erased = await eraseContactEverywhere(account, contactId, ctx.storage);
      for (const [store, n] of Object.entries(erased)) counts[store] = (counts[store] ?? 0) + n;
      done += 1;
    } catch (err) {
      if (err instanceof NotFoundError)
        done += 1; // already gone
      else if (err instanceof AppError && err.code === 'CONTACT_ERASE_BLOCKED')
        blocked.push(contactId);
      else throw err;
    }
    await EraseJobModel.updateOne(
      { _id: job._id },
      blocked.includes(contactId)
        ? { $set: { done, counts } }
        : { $set: { done, counts }, $pull: { contactIds: contactId } },
    );
  }
  if (blocked.length) {
    await EraseJobModel.updateOne(
      { _id: job._id },
      { $set: { contactIds: blocked }, $inc: { retried: 1 } },
    );
    await ctx.jobs.enqueue(
      'contacts.erase',
      { accountId, eraseJobId },
      { delay: ERASE_RETRY_DELAY_MS },
    );
    return { done, retried: blocked.length };
  }
  await EraseJobModel.updateOne({ _id: job._id }, { $set: { status: 'done', contactIds: [] } });
  await notify({
    accountId: account,
    userIds: [job.requestedBy],
    type: 'contacts.erase_completed',
    title: 'Contacts erased',
    body: `${String(job.total)} contacts were erased permanently.`,
    link: '/contacts',
  });
  notifyAccount(accountId, 'contacts.changed', { reason: 'erased' });
  return { done, retried: 0 };
};
