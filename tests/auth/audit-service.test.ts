import type { Request } from 'express';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AuditLogModel } from '../../src/db/models/audit-log.model';
import {
  actorFromRequest,
  auditRequest,
  recordAudit,
  sanitizeMeta,
} from '../../src/modules/audit/audit.service';
import { useTestDb } from '../helpers/db';

useTestDb();

describe('sanitizeMeta', () => {
  it('drops secret-looking keys and masks emails, recursively', () => {
    expect(
      sanitizeMeta({
        roleKey: 'manager',
        password: 'x',
        newPasswordHash: 'y',
        resetToken: 'z',
        otpCode: '123456',
        cookie: 'c',
        invitee: 'asha@example.com',
        nested: { authorization: 'Bearer a', fields: ['name', 'timezone'], who: 'b@c.io' },
        long: 'x'.repeat(600),
      }),
    ).toEqual({
      roleKey: 'manager',
      invitee: 'a***@example.com',
      nested: { fields: ['name', 'timezone'], who: 'b***@c.io' },
      long: 'x'.repeat(500),
    });
    expect(sanitizeMeta(null)).toBeNull();
    expect(sanitizeMeta(42)).toBe(42);
  });
});

describe('recordAudit', () => {
  it('stores actor, target, sanitized meta and ip', async () => {
    const accountId = new Types.ObjectId();
    const userId = new Types.ObjectId();
    await recordAudit({
      accountId: accountId.toString(),
      actor: { type: 'user', id: userId.toString() },
      action: 'team.invited',
      target: { type: 'user', id: 'u1' },
      meta: { email: 'x@y.co', token: 'secret' },
      ip: '10.0.0.1',
    });
    const entry = await AuditLogModel.findOne({ accountId }).lean();
    expect(entry).toMatchObject({
      action: 'team.invited',
      ip: '10.0.0.1',
      target: { type: 'user', id: 'u1' },
      meta: { email: 'x***@y.co' },
    });
    expect(entry?.actor.id?.toString()).toBe(userId.toString());
    expect(entry?.actor.platform).toBe(false);
  });

  it('never throws (bad account id is logged and swallowed)', async () => {
    await expect(
      recordAudit({ accountId: '', actor: { type: 'system' }, action: 'auth.login' }),
    ).resolves.toBeUndefined();
  });
});

describe('actorFromRequest / auditRequest', () => {
  const base = { ip: '1.1.1.1' } as Request;

  it('maps users, impersonation, api keys and anonymous requests', () => {
    expect(actorFromRequest(base)).toEqual({ type: 'system' });
    const userReq = {
      ...base,
      auth: { kind: 'user', userId: 'u', impersonatorId: 'admin' },
    } as unknown as Request;
    expect(actorFromRequest(userReq)).toEqual({ type: 'user', id: 'u', impersonatorId: 'admin' });
    const keyReq = { ...base, auth: { kind: 'api_key', apiKeyId: 'k' } } as unknown as Request;
    expect(actorFromRequest(keyReq)).toEqual({ type: 'api_key', id: 'k' });
  });

  it('records for the caller account with the request ip', async () => {
    const accountId = new Types.ObjectId().toString();
    const userId = new Types.ObjectId().toString();
    const req = { ip: '2.2.2.2', auth: { kind: 'user', accountId, userId } } as unknown as Request;
    await auditRequest(req, 'account.updated', { meta: { fields: ['name'] } });
    const entry = await AuditLogModel.findOne({ accountId }).lean();
    expect(entry).toMatchObject({
      action: 'account.updated',
      ip: '2.2.2.2',
      meta: { fields: ['name'] },
    });
  });
});
