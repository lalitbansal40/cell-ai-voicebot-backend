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
      // Gate = measured coverage at Phase 1 sign-off rounded down to the nearest 5
      // (92.9 / 82.8 / 90.2 / 94.5) — CI fails if coverage drops below it.
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
