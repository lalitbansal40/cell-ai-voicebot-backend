import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { PlatformSettingsModel } from '../../src/db/models/platform-settings.model';
import {
  readOpsStatus,
  recordBackup,
  recordRelease,
  recordRestoreDrill,
} from '../../src/modules/ops/ops-status';
import { parseOpsRecord } from '../../src/ops/ops-record';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let app: ReturnType<typeof buildTestApp>;
let platform: TestAccount;
let superadmin: TestUser;

beforeAll(async () => {
  app = buildTestApp();
  platform = await createTestAccount({ isPlatform: true, slug: `platform-${Date.now()}` });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

describe('ops-record and Admin → System', () => {
  it('reads its arguments and refuses anything else', () => {
    expect(parseOpsRecord(['backup', '--ok', '--bytes', '42'])).toEqual({
      kind: 'backup',
      ok: true,
      bytes: 42,
    });
    expect(parseOpsRecord(['restore-drill', '--rto-minutes', '38'])).toEqual({
      kind: 'restore-drill',
      rtoMinutes: 38,
    });
    expect(
      parseOpsRecord([
        'release',
        '--tag',
        'release-20261102-aaaaaaa',
        '--backend',
        A,
        '--frontend',
        B,
      ]),
    ).toMatchObject({ kind: 'release', backend: A });
    for (const bad of [
      [],
      ['backup', '--bytes', '1'],
      ['backup', '--ok', '--failed', '--bytes', '1'],
      ['backup', '--ok', '--bytes', '-1'],
      ['restore-drill'],
      ['release', '--tag', 'main', '--backend', A, '--frontend', B],
      ['release', '--tag', 'release-20261102-aaaaaaa', '--backend', 'short', '--frontend', B],
    ]) {
      expect(() => parseOpsRecord(bad)).toThrow();
    }
  });

  it('records backup, drill and release; the drill and the release are audited', async () => {
    await PlatformSettingsModel.deleteMany({ key: 'opsStatus' });
    expect(await readOpsStatus()).toEqual({
      lastBackup: null,
      lastRestoreDrill: null,
      lastRelease: null,
    });
    const now = new Date();
    await recordBackup(now, true, 1_048_576);
    await recordRestoreDrill(now, 38);
    await recordRelease(now, { tag: 'release-20261102-aaaaaaa', backend: A, frontend: B });
    const status = await readOpsStatus();
    expect(status.lastBackup).toMatchObject({ ok: true, bytes: 1_048_576 });
    expect(status.lastRestoreDrill).toMatchObject({ rtoMinutes: 38 });
    expect(status.lastRelease).toMatchObject({ tag: 'release-20261102-aaaaaaa', backend: A });
    const actions = (await AuditLogModel.find({ accountId: platform.account._id }).lean()).map(
      (r) => r.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['ops.restore_drill_recorded', 'ops.release_recorded']),
    );
  });

  it('GET /admin/system: superadmins only, with no secrets in it', async () => {
    const res = await request(app)
      .get('/api/v1/admin/system')
      .set('Authorization', `Bearer ${superadmin.token}`);
    expect(res.status).toBe(200);
    const body = res.body as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      mongo: { ok: true },
      redis: { ok: true },
      certificate: null,
    });
    expect(Object.keys(body.data.queues as object)).toEqual(
      expect.arrayContaining(['whatsapp', 'webhooks', 'maintenance']),
    );
    expect(body.data.superadminsWithoutMfa).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(body);
    for (const leak of ['mongodb://', 'redis://', 'password', '@'])
      expect(text).not.toContain(leak);

    const customer = await createTestAccount();
    const owner = await customer.addUser('owner');
    const refused = await request(app)
      .get('/api/v1/admin/system')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(refused.status).toBe(403);
    expect((await request(app).get('/api/v1/admin/system')).status).toBe(401);
  });
});
