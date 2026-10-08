import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

import { LocalStorage, signingKey } from '../../src/core/storage';
import type { ContactJobData, ContactJobName, ContactJobs } from '../../src/modules/contacts/jobs';

export interface QueuedContactJob<N extends ContactJobName = ContactJobName> {
  name: N;
  data: ContactJobData[N];
}

/** A `ContactJobs` that records what would be enqueued (tests run processors directly). */
export const recordingContactJobs = (): { jobs: ContactJobs; queued: QueuedContactJob[] } => {
  const queued: QueuedContactJob[] = [];
  return {
    queued,
    jobs: {
      enqueue(name, data) {
        queued.push({ name, data });
        return Promise.resolve();
      },
    },
  };
};

/** Local storage in a fresh temp dir, removed after the test file. */
export const useTempStorage = (): LocalStorage => {
  const root = mkdtempSync(path.join(tmpdir(), 'cav-storage-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  return new LocalStorage(
    root,
    'http://localhost:5100',
    signingKey({ NODE_ENV: 'test', ENCRYPTION_KEY: undefined }),
  );
};
