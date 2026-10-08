import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    // First run downloads the MongoDB binary for mongodb-memory-server.
    hookTimeout: 120_000,
    // One shared in-memory MongoDB replica set for all files (each file uses its own DB).
    globalSetup: ['./tests/setup/mongo.global.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/README.md'],
      // Gate = measured coverage at Phase 2 sign-off rounded down to the nearest 5
      // (95.2 / 83.7 / 94.2 / 97.2) — CI fails if coverage drops below it.
      thresholds: { statements: 95, branches: 80, functions: 90, lines: 95 },
    },
  },
});
