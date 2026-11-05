import type { Queue } from 'bullmq';

import type { VoiceResultEvent } from '../../../core/voice-api/types';

/**
 * VAPI jobs on the `campaigns` queue. Stable ids: a batch / poll job that is already
 * waiting is not added twice; results dedupe on request + number + status.
 */
export const VOICE_JOB_NAMES = ['voice.batch', 'voice.poll', 'voice.result'] as const;
export type VoiceJobName = (typeof VOICE_JOB_NAMES)[number];

export interface VoiceJobData {
  'voice.batch': { campaignId: string };
  'voice.poll': { campaignId: string };
  'voice.result': VoiceResultEvent;
}

export interface VoiceJobs {
  batch(campaignId: string, delayMs?: number): Promise<void>;
  poll(campaignId: string, delayMs?: number): Promise<void>;
  result(event: VoiceResultEvent): Promise<void>;
}

const OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
} as const;

/** BullMQ ids may not contain ':'. */
const safe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);

export const queueVoiceJobs = (queue: Queue): VoiceJobs => ({
  async batch(campaignId, delayMs = 0) {
    // one attempt: a failed batch tick must not repeat a submit; the sweep runs it again
    await queue.add(
      'voice.batch',
      { campaignId },
      { ...OPTIONS, attempts: 1, jobId: `vapi-batch-${campaignId}`, delay: delayMs },
    );
  },
  async poll(campaignId, delayMs = 0) {
    await queue.add(
      'voice.poll',
      { campaignId },
      { ...OPTIONS, attempts: 1, jobId: `vapi-poll-${campaignId}`, delay: delayMs },
    );
  },
  async result(event) {
    await queue.add('voice.result', event, {
      ...OPTIONS,
      jobId: `vres-${safe(event.requestId)}-${event.receiver}-${safe(event.status)}`,
    });
  },
});

let current: VoiceJobs | null = null;

/** The process's queue port (server); `null` → callers run the work inline (tests). */
export const setVoiceJobs = (jobs: VoiceJobs | null): void => {
  current = jobs;
};

export const getVoiceJobs = (): VoiceJobs | null => current;
