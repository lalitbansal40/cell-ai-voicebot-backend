import mongoose, { Types } from 'mongoose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from '../../src/db/migrations';
import { AccountModel } from '../../src/db/models/account.model';
import {
  platformSettingProblems,
  PlatformSettingsModel,
} from '../../src/db/models/platform-settings.model';
import { getSignupSettings, isChildOf, isReseller, kindOf } from '../../src/modules/account/kinds';
import { createTestAccount } from '../helpers/auth';
import { useTestDb } from '../helpers/db';
import { auth } from '../helpers/flows';
import { buildTestApp } from '../helpers/test-app';

useTestDb();
const app = buildTestApp();

const db = () => {
  const handle = mongoose.connection.db;
  if (!handle) throw new Error('no db');
  return handle;
};
const migration = () => {
  const found = MIGRATIONS.find((m) => m.name === '0021-accounts-resellers');
  if (!found) throw new Error('0021 missing');
  return found;
};

describe('account kinds (T19.1)', () => {
  it('helpers: kind of old rows, reseller, child of', () => {
    const reseller = new Types.ObjectId();
    expect(kindOf({})).toBe('business');
    expect(kindOf({ isPlatform: true })).toBe('platform');
    expect(isReseller({ kind: 'reseller' })).toBe(true);
    expect(isChildOf({ kind: 'business', parentAccountId: reseller }, reseller)).toBe(true);
    expect(isChildOf({ kind: 'business', parentAccountId: null }, reseller)).toBe(false);
    expect(isChildOf({ kind: 'reseller', parentAccountId: reseller }, reseller)).toBe(false);
  });

  it('the platform account is always kind platform; new accounts are businesses', async () => {
    const p = await AccountModel.create({
      name: 'P',
      slug: `p-${String(Date.now())}`,
      isPlatform: true,
    });
    expect(p.kind).toBe('platform');
    const b = await createTestAccount();
    expect(b.account.kind).toBe('business');
    expect(b.account.parentAccountId).toBeNull();
  });

  it('/auth/me shows kind, parent and the reseller block', async () => {
    const r = await createTestAccount({
      kind: 'reseller',
      reseller: {
        status: 'pending_approval',
        customersCanTopUp: false,
        approvedAt: null,
        approvedBy: null,
        brand: null,
      },
    });
    const owner = await r.addUser('owner');
    const me = await request(app).get('/api/v1/auth/me').set(auth(owner));
    expect(me.body.data.account).toMatchObject({
      kind: 'reseller',
      parentAccountId: null,
      reseller: { status: 'pending_approval', customersCanTopUp: false },
    });
    const c = await createTestAccount({ parentAccountId: r.account._id });
    const cu = await c.addUser('owner');
    const me2 = await request(app).get('/api/v1/auth/me').set(auth(cu));
    expect(me2.body.data.account).toMatchObject({
      kind: 'business',
      parentAccountId: r.account._id.toString(),
      reseller: null,
    });
  });

  it('signup setting: default, validation', async () => {
    expect(await getSignupSettings()).toEqual({ open: true, resellerSignup: 'open' });
    expect(platformSettingProblems('signup', { open: true, resellerSignup: 'approval' })).toEqual(
      [],
    );
    expect(
      platformSettingProblems('signup', { open: 'yes', resellerSignup: 'x', extra: 1 }),
    ).toHaveLength(3);
    await PlatformSettingsModel.create({
      key: 'signup',
      value: { open: false, resellerSignup: 'closed' },
    });
    expect(await getSignupSettings()).toEqual({ open: false, resellerSignup: 'closed' });
  });

  it('0021: kind + parent backfill, unverified owners verified, signup row; idempotent, additive', async () => {
    const plat = new Types.ObjectId();
    const old = new Types.ObjectId();
    const created = new Date('2026-01-01T00:00:00Z');
    await db()
      .collection('accounts')
      .insertMany([
        { _id: plat, name: 'Platform', slug: 'platform-x', isPlatform: true },
        { _id: old, name: 'Old', slug: 'old-x', isPlatform: false },
      ]);
    const pending = new Types.ObjectId();
    await db().collection('users').insertOne({
      _id: pending,
      accountId: old,
      email: 'pending@example.com',
      status: 'active',
      emailVerifiedAt: null,
      createdAt: created,
    });
    await migration().up(db());
    await migration().up(db());
    expect(await db().collection('accounts').findOne({ _id: plat })).toMatchObject({
      kind: 'platform',
      parentAccountId: null,
    });
    const raw = await db().collection('accounts').findOne({ _id: old });
    expect(raw).toMatchObject({ name: 'Old', slug: 'old-x', kind: 'business', reseller: null });
    expect((await db().collection('users').findOne({ _id: pending }))?.emailVerifiedAt).toEqual(
      created,
    );
    expect(await db().collection('platformSettings').countDocuments({ key: 'signup' })).toBe(1);
    const names = MIGRATIONS.map((m) => m.name);
    expect(names.indexOf('0021-accounts-resellers')).toBe(
      names.indexOf('0020-call-permission-runs') + 1,
    );
  });
});
