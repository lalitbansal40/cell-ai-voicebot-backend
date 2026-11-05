import { defineConfig } from 'vitest/config';

/** DOCS-T7 docs examples smoke (`npm run docs:smoke`); not part of `npm test`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/docs/examples.smoke.ts'],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    globalSetup: ['./tests/setup/mongo.global.ts'],
    fileParallelism: false,
  },
});
