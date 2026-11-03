import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';

import type { Env } from '../../config/env';
import { QUEUES } from '../../core/queues/names';
import { DEFAULT_QUEUE_PREFIX } from '../../core/queues/queue-factory';
import { UserModel } from '../../db/models/user.model';
import { readOpsStatus, type OpsStatus } from '../ops/ops-status';

/** Admin → System (Phase 17): what a superadmin needs to see production is healthy. No secrets. */
export interface SystemStatus extends OpsStatus {
  commit: string;
  builtAt: string;
  env: string;
  uptimeSec: number;
  mongo: { ok: boolean; primary: boolean; version: string | null };
  redis: { ok: boolean; usedMemoryMb: number | null };
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
  certificate: { daysLeft: number } | null;
  superadminsWithoutMfa: number;
}

export interface SystemDeps {
  env: Pick<Env, 'NODE_ENV' | 'TLS_CERT_PATH'>;
  build: { commit: string; builtAt: string };
  /** The app's Redis: the queue handles share it, `INFO memory` gives its size. */
  redis: Redis;
  prefix?: string;
}

const CACHE_MS = 10_000;
const DAY = 86_400_000;

const mongoStatus = async (): Promise<SystemStatus['mongo']> => {
  const db = mongoose.connection.db;
  if (!db) return { ok: false, primary: false, version: null };
  try {
    const admin = db.admin();
    const [hello, build] = await Promise.all([
      admin.command({ hello: 1 }),
      admin.command({ buildInfo: 1 }),
    ]);
    return {
      ok: true,
      primary: hello.isWritablePrimary === true,
      version: typeof build.version === 'string' ? build.version : null,
    };
  } catch {
    return { ok: false, primary: false, version: null };
  }
};

const redisStatus = async (redis: SystemDeps['redis']): Promise<SystemStatus['redis']> => {
  try {
    const info = await redis.info('memory');
    const bytes = /used_memory:(\d+)/.exec(info)?.[1];
    return { ok: true, usedMemoryMb: bytes ? Math.round(Number(bytes) / 1_048_576) : null };
  } catch {
    return { ok: false, usedMemoryMb: null };
  }
};

const certificateDays = async (path: string | undefined, now: Date) => {
  if (!path) return null;
  try {
    const cert = new X509Certificate(await readFile(path));
    return { daysLeft: Math.floor((Date.parse(cert.validTo) - now.getTime()) / DAY) };
  } catch {
    return null;
  }
};

export const createSystemStatus = (deps: SystemDeps) => {
  // read-only handles on the queues, sharing the app's Redis connection
  const queues = Object.values(QUEUES).map(
    (name) =>
      new Queue(name, { connection: deps.redis, prefix: deps.prefix ?? DEFAULT_QUEUE_PREFIX }),
  );
  let cached: { at: number; value: SystemStatus } | null = null;

  const queueCounts = async (): Promise<SystemStatus['queues']> => {
    const out: SystemStatus['queues'] = {};
    for (const q of queues) {
      try {
        const c = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        out[q.name] = {
          waiting: c.waiting ?? 0,
          active: c.active ?? 0,
          delayed: c.delayed ?? 0,
          failed: c.failed ?? 0,
        };
      } catch {
        out[q.name] = { waiting: -1, active: -1, delayed: -1, failed: -1 };
      }
    }
    return out;
  };

  const read = async (now = new Date()): Promise<SystemStatus> => {
    if (cached && now.getTime() - cached.at < CACHE_MS) return cached.value;
    const [mongo, redis, queueState, ops, certificate, superadminsWithoutMfa] = await Promise.all([
      mongoStatus(),
      redisStatus(deps.redis),
      queueCounts(),
      readOpsStatus().catch(() => ({
        lastBackup: null,
        lastRestoreDrill: null,
        lastRelease: null,
      })),
      certificateDays(deps.env.TLS_CERT_PATH, now),
      UserModel.countDocuments({
        platformRole: 'superadmin',
        status: { $ne: 'disabled' },
        'mfa.enabledAt': { $in: [null] },
      }).catch(() => -1),
    ]);
    const value: SystemStatus = {
      commit: deps.build.commit,
      builtAt: deps.build.builtAt,
      env: deps.env.NODE_ENV,
      uptimeSec: Math.round(process.uptime()),
      mongo,
      redis,
      queues: queueState,
      ...ops,
      certificate,
      superadminsWithoutMfa,
    };
    cached = { at: now.getTime(), value };
    return value;
  };

  return { read, close: () => Promise.all(queues.map((q) => q.close())) };
};
