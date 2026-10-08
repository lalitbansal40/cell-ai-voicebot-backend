import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

/**
 * ONE in-memory replica set for the whole test run (instead of one per file).
 * Several mongod replica sets starting in parallel made transactions hang
 * intermittently; a shared one is faster and stable. Each test file uses its
 * own database (see tests/helpers/mongo.ts).
 */
let replSet: MongoMemoryReplSet | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  // `__DB__` is replaced by a unique database name per test file.
  project.provide('mongoUriTemplate', replSet.getUri('__DB__'));
  return async () => {
    await replSet?.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUriTemplate: string;
  }
}
