import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Types } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_PURGE_JOB,
  processMaintenanceJob,
} from '../../src/core/queues/workers/maintenance.worker';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { AUDIT_ACTIONS, isAuditAction } from '../../src/modules/audit/audit-actions';
import { purgeAuditLogs } from '../../src/modules/audit/audit-purge';
import { issueRefresh, rotateRefresh } from '../../src/modules/auth/refresh.service';
import { createLogger } from '../../src/shared/logger';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
let t: TestAccount;
let owner: TestUser;
let manager: TestUser;

const seed = async (
  accountId: Types.ObjectId,
  count: number,
  extra: Partial<Record<string, unknown>> = {},
) => {
  const base = Date.parse('2026-09-01T00:00:00Z');
  await AuditLogModel.insertMany(
    Array.from({ length: count }, (_, i) => ({
      accountId,
      actor: { type: 'user', id: owner.user._id },
      action: i % 2 ? 'team.invited' : 'account.updated',
      target: { type: i % 2 ? 'user' : 'account', id: String(i) },
      meta: { i },
      at: new Date(base + i * 60_000),
      ...extra,
    })),
  );
};

beforeAll(async () => {
  t = await createTestAccount();
  owner = await t.addUser('owner');
  manager = await t.addUser('manager');
  await seed(t.account._id, 25);
});

const list = (q: Record<string, string | number>, token = owner.token) =>
  request(app).get('/api/v1/audit-logs').query(q).set(auth(token));

describe('audit catalogue', () => {
  it('matches docs/conventions/audit.md exactly', () => {
    const doc = readFileSync(path.resolve(__dirname, '../../docs/conventions/audit.md'), 'utf8');
    const documented = [...doc.matchAll(/^\|\s*`([a-z_]+\.[a-z_]+)`\s*\|/gm)].map((m) => m[1]);
    expect(documented.sort()).toEqual([...AUDIT_ACTIONS].sort());
    expect(isAuditAction('team.invited')).toBe(true);
    expect(isAuditAction('team.hacked')).toBe(false);
  });
});

describe('GET /api/v1/audit-logs', () => {
  it('pages newest first with a cursor (10 / 10 / 5) and joins actor names', async () => {
    const first = await list({ limit: 10 });
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(10);
    expect(first.body.meta.hasMore).toBe(true);
    expect(first.body.data[0].meta).toEqual({ i: 24 });
    expect(first.body.data[0].actor).toMatchObject({
      type: 'user',
      name: owner.user.name,
      platform: false,
    });
    const second = await list({ limit: 10, cursor: first.body.meta.nextCursor as string });
    expect(second.body.data[0].meta).toEqual({ i: 14 });
    const third = await list({ limit: 10, cursor: second.body.meta.nextCursor as string });
    expect(third.body.data).toHaveLength(5);
    expect(third.body.meta).toEqual({ hasMore: false, nextCursor: null });
  });

  it('filters by action (exact / prefix), target type, actor and time range', async () => {
    expect((await list({ action: 'team.invited', limit: 100 })).body.data).toHaveLength(12);
    expect((await list({ action: 'account.*', limit: 100 })).body.data).toHaveLength(13);
    expect((await list({ targetType: 'user', limit: 100 })).body.data).toHaveLength(12);
    expect((await list({ actorId: manager.user._id.toString() })).body.data).toHaveLength(0);
    const ranged = await list({
      from: '2026-09-01T00:05:00Z',
      to: '2026-09-01T00:09:00Z',
      limit: 100,
    });
    expect(ranged.body.data.map((e: { meta: { i: number } }) => e.meta.i)).toEqual([9, 8, 7, 6, 5]);
  });

  it('validates the query', async () => {
    for (const q of [
      { cursor: 'bad*cursor' },
      { cursor: Buffer.from('{"x":1}').toString('base64url') },
      { action: 'DROP' },
      { from: 'yesterday' },
      { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' },
      { limit: 101 },
    ]) {
      expect((await list(q as unknown as Record<string, string>)).status).toBe(422);
    }
  });

  it('is limited to owner/admin and to the caller account', async () => {
    expect((await list({}, manager.token)).status).toBe(403);
    const other = await createTestAccount();
    const otherOwner = await other.addUser('owner');
    expect((await list({}, otherOwner.token)).body.data).toEqual([]);
  });
});

describe('refresh reuse is audited', () => {
  it('records auth.refresh_reuse_detected', async () => {
    const first = await issueRefresh({ userId: manager.user._id, accountId: t.account._id });
    await rotateRefresh(first.raw);
    await expect(rotateRefresh(first.raw)).rejects.toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    expect(
      await AuditLogModel.countDocuments({
        action: 'auth.refresh_reuse_detected',
        'actor.id': manager.user._id,
      }),
    ).toBe(1);
  });
});

describe('purge', () => {
  it('deletes only entries older than 365 days (also via the maintenance job)', async () => {
    const x = await createTestAccount();
    const now = new Date('2026-10-08T00:00:00Z');
    await AuditLogModel.insertMany([
      {
        accountId: x.account._id,
        actor: { type: 'system' },
        action: 'auth.login',
        at: new Date('2025-10-01T00:00:00Z'),
      },
      {
        accountId: x.account._id,
        actor: { type: 'system' },
        action: 'auth.login',
        at: new Date('2025-10-07T00:00:00Z'),
      },
      {
        accountId: x.account._id,
        actor: { type: 'system' },
        action: 'auth.login',
        at: new Date('2025-10-09T00:00:00Z'),
      },
    ]);
    expect(await purgeAuditLogs(now)).toBeGreaterThanOrEqual(2);
    expect(await AuditLogModel.countDocuments({ accountId: x.account._id })).toBe(1);
    const run = processMaintenanceJob({
      logger: createLogger({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
    });
    await expect(run({ name: AUDIT_PURGE_JOB } as never)).resolves.toEqual({
      deleted: expect.any(Number),
    });
    await expect(run({ name: 'nope' } as never)).rejects.toThrow('Unknown maintenance job');
  });
});
