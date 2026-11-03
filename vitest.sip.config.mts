import { defineConfig } from 'vitest/config';

/** SIP lab suite (Phase 18): needs `npm run sip:lab`; not part of `npm test`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests-sip/**/*.test.ts'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
