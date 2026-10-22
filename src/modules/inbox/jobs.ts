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
