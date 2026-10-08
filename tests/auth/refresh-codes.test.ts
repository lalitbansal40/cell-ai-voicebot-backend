import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthCodeModel } from '../../src/db/models/auth-code.model';
import { RefreshTokenModel } from '../../src/db/models/refresh-token.model';
import {
  consumeOtp,
  consumeResetToken,
  issueOtp,
  issueResetToken,
} from '../../src/modules/auth/codes.service';
import {
  durationMs,
  issueRefresh,
  listActiveSessions,
  revokeAllForUser,
  revokeFamily,
  rotateRefresh,
  setReuseDetectedHook,
} from '../../src/modules/auth/refresh.service';
import { useTestDb } from '../helpers/db';

useTestDb();

const ids = () => ({ userId: new Types.ObjectId(), accountId: new Types.ObjectId() });

afterEach(() => {
  vi.useRealTimers();
  setReuseDetectedHook(undefined);
});

describe('refresh tokens', () => {
  it('parses durations', () => {
    expect(durationMs('30d')).toBe(30 * 86_400_000);
    expect(durationMs('15m')).toBe(900_000);
    expect(durationMs('10s')).toBe(10_000);
  });

  it('stores only the HMAC and rotates within the family', async () => {
    const { userId, accountId } = ids();
    const first = await issueRefresh({
      userId,
      accountId,
      meta: { userAgent: 'UA', ip: '1.2.3.4' },
    });
    expect(first.raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await RefreshTokenModel.countDocuments({ tokenHash: first.raw })).toBe(0);
    expect(first.doc.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const second = await rotateRefresh(first.raw, { ip: '5.6.7.8' });
    expect(second.doc.familyId).toBe(first.doc.familyId);
    expect(second.raw).not.toBe(first.raw);
    const old = await RefreshTokenModel.findById(first.doc._id).lean();
    expect(old?.revokedReason).toBe('rotated');
    expect(old?.replacedBy?.toString()).toBe(second.doc._id.toString());
  });

  it('revokes the whole family when a rotated token is reused', async () => {
    const { userId, accountId } = ids();
    const hook = vi.fn();
    setReuseDetectedHook(hook);
    const first = await issueRefresh({ userId, accountId });
    const second = await rotateRefresh(first.raw);
    await expect(rotateRefresh(first.raw)).rejects.toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    expect(hook).toHaveBeenCalledTimes(1);
    await expect(rotateRefresh(second.raw)).rejects.toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
    const family = await RefreshTokenModel.find({ familyId: first.doc.familyId }).lean();
    expect(family.every((t) => t.revokedAt)).toBe(true);
    expect(family.some((t) => t.revokedReason === 'reuse_detected')).toBe(true);
  });

  it('lets exactly one of two concurrent rotations win', async () => {
    const { userId, accountId } = ids();
    setReuseDetectedHook(() => undefined);
    const first = await issueRefresh({ userId, accountId });
    const results = await Promise.allSettled([rotateRefresh(first.raw), rotateRefresh(first.raw)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({
      code: 'AUTH_SESSION_REVOKED',
    });
  });

  it('rejects unknown and expired tokens', async () => {
    await expect(rotateRefresh('unknown-token')).rejects.toMatchObject({
      code: 'AUTH_UNAUTHENTICATED',
    });
    const { userId, accountId } = ids();
    const first = await issueRefresh({ userId, accountId });
    await RefreshTokenModel.updateOne(
      { _id: first.doc._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await expect(rotateRefresh(first.raw)).rejects.toMatchObject({ code: 'AUTH_SESSION_REVOKED' });
  });

  it('revokes families / all sessions and lists active sessions', async () => {
    const { userId, accountId } = ids();
    const a = await issueRefresh({ userId, accountId, meta: { userAgent: 'Chrome' } });
    const b = await issueRefresh({ userId, accountId, meta: { userAgent: 'Firefox' } });
    await rotateRefresh(a.raw);
    const sessions = await listActiveSessions(userId);
    expect(sessions.map((s) => s.id).sort()).toEqual([a.doc.familyId, b.doc.familyId].sort());
    expect(await revokeFamily(b.doc.familyId, 'session_revoked')).toBe(1);
    expect((await listActiveSessions(userId)).map((s) => s.id)).toEqual([a.doc.familyId]);
    const c = await issueRefresh({ userId, accountId });
    expect(await revokeAllForUser(userId, 'logout_all', { exceptFamilyId: c.doc.familyId })).toBe(
      1,
    );
    expect((await listActiveSessions(userId)).map((s) => s.id)).toEqual([c.doc.familyId]);
  });
});

describe('email OTP', () => {
  it('issues a 6-digit code that can be used once', async () => {
    const userId = new Types.ObjectId();
    const code = await issueOtp(userId);
    expect(code).toMatch(/^\d{6}$/);
    const stored = await AuthCodeModel.findOne({ userId }).lean();
    expect(stored?.codeHash).not.toContain(code);
    await consumeOtp(userId, code);
    await expect(consumeOtp(userId, code)).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
  });

  it('counts wrong attempts and burns the code on the 5th', async () => {
    const userId = new Types.ObjectId();
    const code = await issueOtp(userId);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i += 1) {
      await expect(consumeOtp(userId, wrong)).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
    }
    await expect(consumeOtp(userId, wrong)).rejects.toMatchObject({
      code: 'AUTH_TOO_MANY_ATTEMPTS',
    });
    await expect(consumeOtp(userId, code)).rejects.toMatchObject({
      code: 'AUTH_TOO_MANY_ATTEMPTS',
    });
  });

  it("rejects malformed codes and other users' codes", async () => {
    const a = new Types.ObjectId();
    const b = new Types.ObjectId();
    const codeA = await issueOtp(a);
    await issueOtp(b);
    await expect(consumeOtp(b, codeA)).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
    await expect(consumeOtp(a, '12ab56')).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
  });

  it('expires after 10 minutes', async () => {
    const userId = new Types.ObjectId();
    const code = await issueOtp(userId);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(consumeOtp(userId, code)).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
  });

  it('enforces the 60 s resend cooldown and 5 sends per hour', async () => {
    const userId = new Types.ObjectId();
    await issueOtp(userId);
    const err = (await issueOtp(userId).catch((e: unknown) => e)) as {
      code: string;
      retryAfterSec: number;
    };
    expect(err).toMatchObject({ code: 'AUTH_TOO_MANY_ATTEMPTS' });
    expect(err.retryAfterSec).toBeGreaterThan(0);
    expect(err.retryAfterSec).toBeLessThanOrEqual(60);

    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    for (let i = 1; i <= 4; i += 1) {
      vi.setSystemTime(start + i * 61_000);
      await issueOtp(userId);
    }
    vi.setSystemTime(start + 5 * 61_000);
    await expect(issueOtp(userId)).rejects.toMatchObject({ code: 'AUTH_TOO_MANY_ATTEMPTS' });
    vi.setSystemTime(start + 61 * 60_000);
    await expect(issueOtp(userId)).resolves.toMatch(/^\d{6}$/);
  });
});

describe('reset tokens', () => {
  it('are single use and bound to the user', async () => {
    const userId = new Types.ObjectId();
    const raw = await issueResetToken(userId);
    expect((await consumeResetToken(raw)).toString()).toBe(userId.toString());
    await expect(consumeResetToken(raw)).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
  });

  it('expire after 30 minutes and reject malformed input', async () => {
    const raw = await issueResetToken(new Types.ObjectId());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await expect(consumeResetToken(raw)).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
    vi.useRealTimers();
    await expect(consumeResetToken('../../etc')).rejects.toMatchObject({
      code: 'AUTH_CODE_INVALID',
    });
  });

  it('a new reset token invalidates the previous one', async () => {
    const userId = new Types.ObjectId();
    const first = await issueResetToken(userId);
    const second = await issueResetToken(userId);
    await expect(consumeResetToken(first)).rejects.toMatchObject({ code: 'AUTH_CODE_INVALID' });
    await expect(consumeResetToken(second)).resolves.toBeTruthy();
  });
});
