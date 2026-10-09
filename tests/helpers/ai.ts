import type { AiJobData, AiJobName, AiJobs } from '../../src/core/ai/jobs';

/** AI jobs that are recorded instead of queued (tests). */
export const recordingAiJobs = () => {
  const queued: { name: AiJobName; data: AiJobData[AiJobName] }[] = [];
  const jobs: AiJobs = {
    enqueue(name, data) {
      queued.push({ name, data });
      return Promise.resolve();
    },
  };
  return { jobs, queued };
};
