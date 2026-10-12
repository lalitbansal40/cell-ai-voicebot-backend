import { Types } from 'mongoose';
import { beforeAll, describe, expect, it } from 'vitest';

import { CallModel } from '../../src/db/models/call.model';
import { RoleModel } from '../../src/db/models/role.model';
import { UserModel } from '../../src/db/models/user.model';
import { authorizeTopic } from '../../src/modules/calls/topic-auth';
import { createTestAccount, type TestAccount, type TestUser } from '../helpers/auth';
import { useTestDb } from '../helpers/db';

useTestDb();

let t: TestAccount;
let viewer: TestUser;
let callId: string;

beforeAll(async () => {
  t = await createTestAccount();
  viewer = await t.addUser('viewer');
  const call = await CallModel.create({
    accountId: t.account._id,
    direction: 'outbound',
    provider: 'webcall',
    from: 'webcall',
    to: 'webcall:x',
    isTest: true,
    source: { kind: 'agent' },
    timestamps: { queuedAt: new Date() },
  });
  callId = call._id.toString();
});

const ctx = (user: { _id: Types.ObjectId }, accountId = t.account._id) => ({
  accountId: accountId.toString(),
  userId: user._id.toString(),
});

describe('call topic authorisation', () => {
  it('allows a call of the account to a user with calls.read', async () => {
    expect(await authorizeTopic(ctx(viewer.user), { kind: 'call', id: callId })).toBe(true);
  });

  it('refuses other accounts, unknown calls, campaigns and bad ids', async () => {
    const other = await createTestAccount();
    const stranger = await other.addUser('owner');
    expect(
      await authorizeTopic(ctx(stranger.user, other.account._id), { kind: 'call', id: callId }),
    ).toBe(false);
    expect(
      await authorizeTopic(ctx(viewer.user), { kind: 'call', id: new Types.ObjectId().toString() }),
    ).toBe(false);
    expect(await authorizeTopic(ctx(viewer.user), { kind: 'campaign', id: callId })).toBe(false);
    expect(
      await authorizeTopic({ accountId: 'x', userId: 'y' }, { kind: 'call', id: callId }),
    ).toBe(false);
  });

  it('refuses disabled users and roles without calls.read; superadmins viewing the account pass', async () => {
    const disabled = await t.addUser('viewer');
    await UserModel.updateOne({ _id: disabled.user._id }, { status: 'disabled' });
    expect(await authorizeTopic(ctx(disabled.user), { kind: 'call', id: callId })).toBe(false);
    const role = await RoleModel.create({
      accountId: t.account._id,
      key: `custom-${String(Date.now())}`,
      name: 'No calls',
      permissions: ['contacts.read'],
      isSystem: false,
    });
    const limited = await t.addUser('viewer', { roleId: role._id });
    expect(await authorizeTopic(ctx(limited.user), { kind: 'call', id: callId })).toBe(false);
    const platform = await createTestAccount();
    const admin = await platform.addUser('owner', { platformRole: 'superadmin' });
    expect(await authorizeTopic(ctx(admin.user), { kind: 'call', id: callId })).toBe(true);
    const plain = await platform.addUser('owner');
    expect(await authorizeTopic(ctx(plain.user), { kind: 'call', id: callId })).toBe(false);
    expect(
      await authorizeTopic(
        { accountId: t.account._id.toString(), userId: new Types.ObjectId().toString() },
        { kind: 'call', id: callId },
      ),
    ).toBe(false);
  });
});
