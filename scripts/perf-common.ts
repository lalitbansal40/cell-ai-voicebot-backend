/**
 * Shared by the Phase 16 load checks. The real API runs as its own process (`dist/index.js`,
 * so `npm run build` first) on the throw-away database `cav_perf` and Redis database 9. Refuses
 * production, and everything it made is dropped at the end. Never point this at a shared server.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openSync } from 'node:fs';
import path from 'node:path';

import { Redis } from 'ioredis';
import type { Types } from 'mongoose';
import mongoose from 'mongoose';

import { getEnv } from '../src/config/env';
import { credit } from '../src/core/billing/engine';
import { createWallet } from '../src/core/billing/wallets';
import { buildFakeCode } from '../src/core/meta';
import { AccountModel } from '../src/db/models/account.model';
import { ApiKeyModel } from '../src/db/models/api-key.model';
import { UserModel } from '../src/db/models/user.model';
import { WhatsAppChannelModel } from '../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../src/db/models/whatsapp-template.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { generateApiKey, PREFIX_LENGTH } from '../src/modules/api-keys/api-keys.service';
import { sha256Hex } from '../src/modules/auth/hmac';
import { signAccessToken } from '../src/modules/auth/tokens';
import { syncSystemRoles } from '../src/modules/rbac/roles.service';
import { createLogger } from '../src/shared/logger';

import { perfUri } from './perf-reports';

export const PERF_PORT = 5197;
export const BASE = `http://127.0.0.1:${String(PERF_PORT)}`;

export const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const uid = () => randomBytes(5).toString('hex');

const redisDb9 = (url: string) => {
  const u = new URL(url);
  u.pathname = '/9';
  return u.toString();
};

export interface PerfRun {
  server: ChildProcess;
  /** Kill/restart this isolated API; Redis and Mongo survive. */
  restart(): Promise<void>;
  redis: Redis;
  stop(): Promise<void>;
}

/** Starts the API on the throw-away stores and waits until it answers. */
export const startPerf = async (extraEnv: Record<string, string> = {}): Promise<PerfRun> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('Load checks refuse NODE_ENV=production');
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const uri = perfUri(env.MONGODB_URI);
  await connectMongo({ ...env, MONGODB_URI: uri }, logger);
  const db = mongoose.connection.db;
  if (db?.databaseName !== 'cav_perf') throw new Error('Refusing: not the cav_perf database');
  await mongoose.connection.dropDatabase();
  const redisUrl = redisDb9(env.REDIS_URL);
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  await redis.flushdb();
  const childEnv = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PERF_PORT),
    HOST: '127.0.0.1',
    MONGODB_URI: uri,
    REDIS_URL: redisUrl,
    LOG_LEVEL: 'error',
    TRUST_PROXY: '1',
    WHATSAPP_ENABLED: 'true',
    META_PROVIDER: 'fake',
    WORKERS_ENABLED: 'true',
    EMAIL_DRIVER: 'log',
    ...extraEnv,
  };
  const launch = () =>
    spawn(process.execPath, ['--env-file-if-exists=.env', path.join('dist', 'index.js')], {
      env: { ...childEnv, WORKERS_ENABLED: process.env.PERF_SPLIT ? 'false' : 'true' },
      // PERF_SERVER_LOG=<file> keeps the API's error logs for a failed run
      stdio: [
        'ignore',
        process.env.PERF_SERVER_LOG ? openSync(process.env.PERF_SERVER_LOG, 'w') : 'ignore',
        'inherit',
      ],
    });
  let server = launch();
  // PERF_SPLIT=1: API and workers in two processes, as in production (ADR 0049)
  const worker = process.env.PERF_SPLIT
    ? spawn(process.execPath, ['--env-file-if-exists=.env', path.join('dist', 'index.js')], {
        env: { ...childEnv, PORT: String(PERF_PORT + 1), WORKERS_ENABLED: 'true' },
        stdio: ['ignore', 'ignore', 'inherit'],
      })
    : null;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const up = await fetch(`${BASE}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) break;
    if (Date.now() > deadline) throw new Error('The API did not start');
    await sleep(300);
  }
  return {
    get server() {
      return server;
    },
    redis,
    restart: async () => {
      if (worker) throw new Error('Restart check requires one API/worker process');
      const previous = server;
      await new Promise<void>((resolve) => {
        previous.once('exit', () => resolve());
        previous.kill('SIGKILL');
      });
      server = launch();
      const until = Date.now() + 60_000;
      while (
        !(await fetch(`${BASE}/health`).then(
          (r) => r.ok,
          () => false,
        ))
      ) {
        if (server.exitCode !== null || Date.now() > until)
          throw new Error('The isolated API did not restart');
        await sleep(200);
      }
    },
    stop: async () => {
      server.kill('SIGTERM');
      worker?.kill('SIGTERM');
      await sleep(2_000);
      if (server.exitCode === null) server.kill('SIGKILL');
      if (worker && worker.exitCode === null) worker.kill('SIGKILL');
      await redis.flushdb();
      redis.disconnect();
      await mongoose.connection.dropDatabase().catch(() => undefined);
      await disconnectMongo();
    },
  };
};

export const RUPEE = 1_000_000;

export interface PerfWorld {
  accountId: Types.ObjectId;
  ownerToken: string;
  ownerId: Types.ObjectId;
  phoneNumberId: string;
  wabaId: string;
  appSecretHeader: (body: string) => string;
}

/** An account with an owner, a funded wallet and a connected fake number. */
export const seedWorld = async (signature: (body: string) => string): Promise<PerfWorld> => {
  const tag = uid();
  const account = await AccountModel.create({
    name: `Perf ${tag}`,
    slug: `perf-${tag}`,
    limits: { maxConcurrentCalls: 100, dialsPerMinute: 6000 },
    settings: {
      callingWindow: { start: '00:00', end: '23:59', days: [0, 1, 2, 3, 4, 5, 6] },
      callCaps: { perDay: 1000, perWeek: 5000, minGapMinutes: 0 },
    },
  });
  const roles = await syncSystemRoles(account._id);
  const user = await UserModel.create({
    accountId: account._id,
    roleId: roles.owner,
    name: 'Perf',
    email: `perf-${tag}@example.com`,
    passwordHash: 'x',
    status: 'active',
    emailVerifiedAt: new Date(),
  });
  await AccountModel.updateOne({ _id: account._id }, { ownerId: user._id });
  await createWallet(account._id);
  await credit({
    accountId: account._id,
    type: 'adjustment',
    amountMicros: 1_000_000 * RUPEE,
    ref: { type: 'manual', id: 'perf' },
    idempotencyKey: `perf-${tag}`,
  });
  const { token } = await signAccessToken(
    {
      sub: user._id.toString(),
      acc: account._id.toString(),
      rid: user.roleId.toString(),
      tv: user.tokenVersion,
      sid: `perf_${tag}`,
    },
    '2h',
  );
  // through the real connect flow, so the token is one the fake Meta accepts
  const code = buildFakeCode({
    businessName: `Perf ${tag}`,
    phone: `+91 9${String(Date.now() % 1000).padStart(3, '0')}1 ${String(
      Math.floor(Math.random() * 90_000) + 10_000,
    )}`,
    displayName: 'Perf',
    mode: 'cloud_api',
    outcome: 'finish',
  });
  const connected = await fetch(`${BASE}/api/v1/whatsapp/channels/embedded-signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ code, mode: 'cloud_api' }),
  });
  if (!connected.ok)
    throw new Error(`connect: ${String(connected.status)} ${await connected.text()}`);
  const channel = await WhatsAppChannelModel.findOne({ accountId: account._id }).lean();
  if (!channel?.phoneNumberId) throw new Error('No number was connected');
  const { wabaId, phoneNumberId } = channel;
  return {
    accountId: account._id,
    ownerId: user._id,
    ownerToken: token,
    phoneNumberId,
    wabaId,
    appSecretHeader: signature,
  };
};

export const seedTemplate = async (w: PerfWorld, name = 'perf_notice') => {
  // connecting a number syncs templates from Meta: let that finish, or it removes this row
  await sleep(5_000);
  await WhatsAppTemplateModel.create({
    accountId: w.accountId,
    wabaId: w.wabaId,
    name,
    language: 'en',
    category: 'UTILITY',
    status: 'APPROVED',
    metaTemplateId: `fake_tpl_${uid()}`,
    components: [{ type: 'BODY', text: 'Your request is received.' }],
    variables: [],
  });
};

export const newKey = async (w: PerfWorld, scopes: string[]): Promise<string> => {
  const key = generateApiKey(false);
  await ApiKeyModel.create({
    accountId: w.accountId,
    name: `perf-${uid()}`,
    prefix: key.slice(0, PREFIX_LENGTH),
    keyHash: sha256Hex(key),
    scopes,
    createdBy: w.ownerId,
  });
  return key;
};

export const report = (pass: boolean): void => {
  console.info(pass ? 'PASS' : 'FAIL');
  if (!pass) process.exitCode = 1;
};
