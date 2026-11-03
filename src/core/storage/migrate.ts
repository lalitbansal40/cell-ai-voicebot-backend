import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import type { StorageProvider } from './storage.types';

/**
 * Copies every stored file from local disk to S3 before production switches `STORAGE_DRIVER`
 * (Phase 17, ADR 0049). Keys stay the same, so stored references keep working. Each file is read
 * back from the target and compared by size and SHA-256. Resumable: keys are taken in order and the
 * last finished key is saved after each batch. Never reports a key (they hold account ids).
 */
export interface MigrateState {
  lastKey: string | null;
  copied: number;
  bytes: number;
}

export interface MigrateResult extends MigrateState {
  total: number;
  failed: number;
  done: boolean;
}

/** Recordings being written right now live here; they are not stored files yet. */
const SKIP_DIRS = new Set(['tmp-rec']);

const TYPES: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  pdf: 'application/pdf',
  csv: 'text/csv',
  txt: 'text/plain',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const contentTypeOf = (key: string): string =>
  TYPES[key.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** Every file under `root`, as storage keys, sorted (so a run can resume after a key). */
export const listLocalKeys = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!(prefix === '' && SKIP_DIRS.has(entry.name))) {
          await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        }
      } else if (entry.isFile()) out.push(`${prefix}${entry.name}`);
    }
  };
  await walk(root, '');
  return out.sort();
};

const digest = async (stream: Readable): Promise<{ size: number; sha256: string }> => {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    hash.update(buf);
  }
  return { size, sha256: hash.digest('hex') };
};

export const migrateStorage = async (input: {
  keys: string[];
  source: StorageProvider;
  target: StorageProvider;
  state: MigrateState;
  dryRun: boolean;
  batch: number;
  saveState: (state: MigrateState) => Promise<void>;
  /** Bytes of a key on the source, for the dry run's total. */
  sizeOf: (key: string) => Promise<number>;
}): Promise<MigrateResult> => {
  const todo = input.keys.filter((k) => input.state.lastKey === null || k > input.state.lastKey);
  const state = { ...input.state };
  let failed = 0;
  if (input.dryRun) {
    let bytes = 0;
    for (const key of todo) bytes += await input.sizeOf(key);
    return { ...state, bytes, total: input.keys.length, failed, done: todo.length === 0 };
  }
  for (let i = 0; i < todo.length; i += input.batch) {
    for (const key of todo.slice(i, i + input.batch)) {
      const before = await digest(await input.source.get(key));
      await input.target.put(key, await input.source.get(key), { contentType: contentTypeOf(key) });
      const after = await digest(await input.target.get(key));
      if (after.size !== before.size || after.sha256 !== before.sha256) {
        failed += 1;
        // stop here: the next run starts again at this key
        await input.saveState(state);
        return { ...state, total: input.keys.length, failed, done: false };
      }
      state.lastKey = key;
      state.copied += 1;
      state.bytes += before.size;
    }
    await input.saveState(state);
  }
  return { ...state, total: input.keys.length, failed, done: true };
};
