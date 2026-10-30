import type { Queue } from 'bullmq';

/** `postcall.send` on the `whatsapp` queue (Phase 15), delayed until the message's time. */
export const POSTCALL_SEND_JOB = 'postcall.send';

export interface PostCallJobData {
  postCallMessageId: string;
}

export interface PostCallJobs {
  enqueueSend(postCallMessageId: string, delayMs: number): Promise<void>;
}

/** Job ids never contain `:`; one job per message (a retry of the job never sends twice). */
export const postCallJobId = (id: string): string => `postcall-${id}`;

export const queuePostCallJobs = (queue: Queue): PostCallJobs => ({
  async enqueueSend(postCallMessageId, delayMs) {
    await queue.add(POSTCALL_SEND_JOB, { postCallMessageId } satisfies PostCallJobData, {
      jobId: postCallJobId(postCallMessageId),
      delay: Math.max(0, delayMs),
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 7 * 86_400 },
    });
  },
});

export const recordingPostCallJobs = (): PostCallJobs & {
  queued: { id: string; delayMs: number }[];
} => {
  const queued: { id: string; delayMs: number }[] = [];
  return {
    queued,
    enqueueSend(id, delayMs) {
      queued.push({ id, delayMs });
      return Promise.resolve();
    },
  };
};

let current: PostCallJobs = { enqueueSend: () => Promise.resolve() };

/** The server sets the `whatsapp` queue jobs (WhatsApp on); tests set recording jobs. */
export const setPostCallJobs = (jobs: PostCallJobs): void => {
  current = jobs;
};
export const getPostCallJobs = (): PostCallJobs => current;
