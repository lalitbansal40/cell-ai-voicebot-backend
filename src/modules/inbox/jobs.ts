import type { JobsOptions, Queue } from 'bullmq';

import { INBOX_LIMITS } from '../../config/limits';

/**
 * Inbox jobs on the `whatsapp` queue (PHASE_10_PLAN §1a). Job data carries ids
 * only — never message text, phones or names. BullMQ job ids never contain `:`.
 */
export const INBOX_JOBS = {
  messageSend: 'message.send',
  mediaDownload: 'media.download',
  readReceipt: 'read.receipt',
  backfill: 'inbox.backfill',
  historyImport: 'inbox.history-import',
} as const;
export type InboxJobName = (typeof INBOX_JOBS)[keyof typeof INBOX_JOBS];

/** Daily maintenance job: 90-day message retention + orphan uploads. */
export const INBOX_RETENTION_JOB = 'inbox-retention';
export const INBOX_RETENTION_CRON = '50 5 * * *';

export const sendJobId = (messageId: string): string => `msg-send-${messageId}`;
export const mediaDownloadJobId = (messageId: string): string => `media-dl-${messageId}`;
export const readReceiptJobId = (messageId: string): string => `read-receipt-${messageId}`;
export const BACKFILL_JOB_ID = 'inbox-backfill';
export const historyImportJobId = (eventId: string): string => `history-import-${eventId}`;

export interface MessageJobData {
  messageId: string;
}

export interface HistoryImportJobData {
  eventId: string;
}

/** Enqueues inbox jobs (same id twice → one job). */
export interface InboxJobs {
  enqueueSend(messageId: string, delayMs?: number): Promise<void>;
  enqueueMediaDownload(messageId: string): Promise<void>;
  enqueueReadReceipt(messageId: string): Promise<void>;
  enqueueBackfill(): Promise<void>;
  enqueueHistoryImport(eventId: string): Promise<void>;
}

const exponential = (attempts: number, delay: number): JobsOptions => ({
  attempts,
  backoff: { type: 'exponential', delay },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
});

export const queueInboxJobs = (queue: Queue): InboxJobs => ({
  async enqueueSend(messageId, delayMs = 0) {
    await queue.add(INBOX_JOBS.messageSend, { messageId } satisfies MessageJobData, {
      ...exponential(INBOX_LIMITS.sendAttempts, INBOX_LIMITS.sendRetryBaseMs),
      jobId: sendJobId(messageId),
      ...(delayMs > 0 ? { delay: delayMs } : {}),
    });
  },
  async enqueueMediaDownload(messageId) {
    await queue.add(INBOX_JOBS.mediaDownload, { messageId } satisfies MessageJobData, {
      ...exponential(INBOX_LIMITS.mediaDownloadAttempts, INBOX_LIMITS.mediaDownloadRetryBaseMs),
      jobId: mediaDownloadJobId(messageId),
    });
  },
  async enqueueReadReceipt(messageId) {
    await queue.add(INBOX_JOBS.readReceipt, { messageId } satisfies MessageJobData, {
      ...exponential(INBOX_LIMITS.readReceiptAttempts, 2000),
      jobId: readReceiptJobId(messageId),
    });
  },
  async enqueueBackfill() {
    await queue.add(INBOX_JOBS.backfill, {}, { ...exponential(5, 30_000), jobId: BACKFILL_JOB_ID });
  },
  async enqueueHistoryImport(eventId) {
    await queue.add(INBOX_JOBS.historyImport, { eventId } satisfies HistoryImportJobData, {
      ...exponential(5, 30_000),
      jobId: historyImportJobId(eventId),
    });
  },
});

/** Records jobs instead of queueing them (scripts / tests that run the processors directly). */
export const recordingInboxJobs = (): InboxJobs & {
  sent: { name: InboxJobName; id: string; delayMs?: number }[];
} => {
  const sent: { name: InboxJobName; id: string; delayMs?: number }[] = [];
  return {
    sent,
    enqueueSend: (id, delayMs = 0) => {
      sent.push({ name: INBOX_JOBS.messageSend, id, ...(delayMs ? { delayMs } : {}) });
      return Promise.resolve();
    },
    enqueueMediaDownload: (id) => {
      sent.push({ name: INBOX_JOBS.mediaDownload, id });
      return Promise.resolve();
    },
    enqueueReadReceipt: (id) => {
      sent.push({ name: INBOX_JOBS.readReceipt, id });
      return Promise.resolve();
    },
    enqueueBackfill: () => {
      sent.push({ name: INBOX_JOBS.backfill, id: BACKFILL_JOB_ID });
      return Promise.resolve();
    },
    enqueueHistoryImport: (id) => {
      sent.push({ name: INBOX_JOBS.historyImport, id });
      return Promise.resolve();
    },
  };
};
