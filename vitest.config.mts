import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    // First run downloads the MongoDB binary for mongodb-memory-server.
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/README.md'],
    },
  },
});
