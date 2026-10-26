import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import '../../src/ops/sync-indexes';

describe('db:sync-indexes (the production index step)', () => {
  it('registers every model before syncing, so production builds all indexes', () => {
    const files = readdirSync(join(__dirname, '../../src/db/models')).filter((f) =>
      f.endsWith('.model.ts'),
    );
    expect(files.length).toBeGreaterThan(0);
    expect(mongoose.modelNames()).toHaveLength(files.length);
  });
});
