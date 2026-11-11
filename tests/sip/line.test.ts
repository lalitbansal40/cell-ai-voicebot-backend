import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { AccountModel } from '../../src/db/models/account.model';
import { AuditLogModel } from '../../src/db/models/audit-log.model';
import { effectiveLine } from '../../src/modules/calls/line';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
let a: TestAccount;
let owner: TestUser;
let superadmin: TestUser;
const header = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
const app = buildTestApp();

beforeAll(async () => {
  a = await createTestAccount();
  owner = await a.addUser('owner');
  const platform = await createTestAccount({ isPlatform: true });
  superadmin = await platform.addUser('owner', { platformRole: 'superadmin' });
});

describe('phone line per account (T18.6)', () => {
  it('sip only when the install has the trunk and the account is switched', () => {
    expect(effectiveLine({ voiceLine: 'sip' }, { TELEPHONY_PROVIDER: 'sip' })).toBe('sip');
    expect(effectiveLine({ voiceLine: 'dryrun' }, { TELEPHONY_PROVIDER: 'sip' })).toBe('dryrun');
    expect(effectiveLine({ voiceLine: 'sip' }, { TELEPHONY_PROVIDER: 'dryrun' })).toBe('dryrun');
    expect(effectiveLine(null, { TELEPHONY_PROVIDER: 'sip' })).toBe('dryrun');
    expect(effectiveLine({}, { TELEPHONY_PROVIDER: 'sip' })).toBe('dryrun');
  });

  it('a superadmin switches the line; the change is audited once on both sides', async () => {
    const url = `/api/v1/admin/accounts/${a.account._id.toString()}`;
    const detail = await request(app).get(url).set(header(superadmin));
    expect(detail.body.data).toMatchObject({
      voiceLine: 'dryrun',
      // the test server has no SIP line: never "connected"
      phoneLine: { server: 'dryrun', connected: false },
      sipSettings: { pulseSec: null, spendMinutesPerHour: null },
    });
    const res = await request(app)
      .patch(`${url}/voice-line`)
      .set(header(superadmin))
      .send({ voiceLine: 'sip' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ voiceLine: 'sip' });
    expect((await AccountModel.findById(a.account._id).lean())?.voiceLine).toBe('sip');
    await request(app)
      .patch(`${url}/voice-line`)
      .set(header(superadmin))
      .send({ voiceLine: 'sip' });
    const rows = await AuditLogModel.find({ action: 'account.voice_line_changed' }).lean();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.meta).toMatchObject({ from: 'dryrun', to: 'sip' });
    await request(app)
      .patch(`${url}/voice-line`)
      .set(header(superadmin))
      .send({ voiceLine: 'dryrun' });
    expect((await AccountModel.findById(a.account._id).lean())?.voiceLine).toBe('dryrun');
  });

  it('sets SIP overrides and validates them', async () => {
    const url = `/api/v1/admin/accounts/${a.account._id.toString()}/sip-settings`;
    const res = await request(app)
      .patch(url)
      .set(header(superadmin))
      .send({ pulseSec: 30, spendMinutesPerHour: null });
    expect(res.status).toBe(200);
    expect((await AccountModel.findById(a.account._id).lean())?.sipSettings).toEqual({
      pulseSec: 30,
      spendMinutesPerHour: null,
    });
    expect(await AuditLogModel.countDocuments({ action: 'account.sip_settings_changed' })).toBe(2);
    const bad = await request(app)
      .patch(url)
      .set(header(superadmin))
      .send({ pulseSec: 0, spendMinutesPerHour: null });
    expect(bad.status).toBe(422);
    const extra = await request(app).patch(url).set(header(superadmin)).send({ pulseSec: 30 });
    expect(extra.status).toBe(422);
  });

  it('account users cannot change the line', async () => {
    const res = await request(app)
      .patch(`/api/v1/admin/accounts/${a.account._id.toString()}/voice-line`)
      .set(header(owner))
      .send({ voiceLine: 'sip' });
    expect(res.status).toBe(403);
    const bad = await request(app)
      .patch(`/api/v1/admin/accounts/${a.account._id.toString()}/voice-line`)
      .set(header(superadmin))
      .send({ voiceLine: 'pstn' });
    expect(bad.status).toBe(422);
  });
});
