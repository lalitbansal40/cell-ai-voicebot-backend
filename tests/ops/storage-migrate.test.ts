import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  contentTypeOf,
  listLocalKeys,
  migrateStorage,
  type MigrateState,
} from '../../src/core/storage/migrate';
import type { StorageProvider } from '../../src/core/storage/storage.types';
import { parseMigrateArgs } from '../../src/ops/storage-migrate';
import { useTempStorage } from '../helpers/contacts';

const source = useTempStorage();

/** An in-memory S3 stand-in; `corrupt` makes one key read back wrong. */
const memory = (corrupt?: string): StorageProvider & { files: Map<string, Buffer> } => {
  const files = new Map<string, Buffer>();
  return {
    driver: 's3',
    files,
    async put(key, body) {
      const chunks: Buffer[] = [];
      for await (const c of Buffer.isBuffer(body) ? Readable.from([body]) : body)
        chunks.push(c as Buffer);
      files.set(key, Buffer.concat(chunks));
      return { key, size: files.get(key)?.length ?? 0 };
    },
    get(key) {
      const f = files.get(key) ?? Buffer.alloc(0);
      return Promise.resolve(Readable.from([key === corrupt ? Buffer.from('changed') : f]));
    },
    delete: () => Promise.resolve(),
    exists: (key) => Promise.resolve(files.has(key)),
    signedUrl: () => Promise.resolve(''),
  };
};

const KEYS = [
  'accounts/a1/recordings/c1.wav',
  'accounts/a1/inbox/m1.jpg',
  'accounts/a2/exports/e1.zip',
];
const seed = async () => {
  for (const [i, key] of KEYS.entries()) {
    await source.put(key, Buffer.from(`file ${String(i)}`), { contentType: 'x' });
  }
  await source.put('tmp-rec/live.wav', Buffer.from('being written'), { contentType: 'x' });
};
const fresh = (): MigrateState => ({ lastKey: null, copied: 0, bytes: 0 });
const root = (source as unknown as { root: string }).root;

describe('storage:migrate-to-s3', () => {
  it('lists stored files in order and leaves out recordings being written', async () => {
    await seed();
    expect(await listLocalKeys(root)).toEqual([...KEYS].sort());
    expect(contentTypeOf('a/b.wav')).toBe('audio/wav');
    expect(contentTypeOf('a/b.unknown')).toBe('application/octet-stream');
  });

  it('dry run copies nothing; a run copies and verifies everything, then has nothing left', async () => {
    await seed();
    const target = memory();
    const keys = await listLocalKeys(root);
    const saved: MigrateState[] = [];
    const base = {
      keys,
      source,
      target,
      batch: 2,
      saveState: (s: MigrateState) => {
        saved.push(s);
        return Promise.resolve();
      },
      sizeOf: () => Promise.resolve(6),
    };
    const dry = await migrateStorage({ ...base, state: fresh(), dryRun: true });
    expect(dry).toMatchObject({ total: 3, bytes: 18, done: false });
    expect(target.files.size).toBe(0);
    const run = await migrateStorage({ ...base, state: fresh(), dryRun: false });
    expect(run).toMatchObject({ total: 3, copied: 3, failed: 0, done: true });
    expect([...target.files.keys()].sort()).toEqual([...KEYS].sort());
    expect(saved).toHaveLength(2);
    const again = await migrateStorage({ ...base, state: run, dryRun: true });
    expect(again).toMatchObject({ done: true, bytes: 0 });
  });

  it('stops at a file that does not read back the same, and resumes there', async () => {
    await seed();
    const keys = await listLocalKeys(root);
    let state = fresh();
    const base = {
      keys,
      source,
      batch: 10,
      dryRun: false,
      saveState: (s: MigrateState) => {
        state = s;
        return Promise.resolve();
      },
      sizeOf: () => Promise.resolve(1),
    };
    const bad = await migrateStorage({ ...base, target: memory(keys[1]), state });
    expect(bad).toMatchObject({ copied: 1, failed: 1, done: false });
    expect(state.lastKey).toBe(keys[0]);
    const good = memory();
    const resumed = await migrateStorage({ ...base, target: good, state });
    expect(resumed).toMatchObject({ copied: 3, done: true });
    expect([...good.files.keys()]).toEqual(keys.slice(1));
  });

  it('reads its arguments', () => {
    expect(parseMigrateArgs([])).toEqual({ dryRun: false, batch: 200 });
    expect(parseMigrateArgs(['--dry-run', '--batch', '50'])).toEqual({ dryRun: true, batch: 50 });
    expect(() => parseMigrateArgs(['--batch', '0'])).toThrow();
  });
});
