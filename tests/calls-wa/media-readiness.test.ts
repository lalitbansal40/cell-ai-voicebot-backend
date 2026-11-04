import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { CallModel } from '../../src/db/models/call.model';
import {
  readWhatsAppCallsStatus,
  type WhatsAppCallsEnv,
} from '../../src/modules/admin/wa-calls-status';
import { healthIssues, HEALTH_LIMITS } from '../../src/ops/health-rules';
import { useTestDb } from '../helpers/db';

useTestDb();

const now = new Date('2026-11-04T10:00:00Z');
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const env = (over: Partial<WhatsAppCallsEnv> = {}): WhatsAppCallsEnv => ({
  WHATSAPP_ENABLED: true,
  WA_MEDIA_ENABLED: true,
  WA_MEDIA_PUBLIC_IP: '203.0.113.7',
  WA_MEDIA_PORT_MIN: 40_000,
  WA_MEDIA_PORT_MAX: 40_999,
  ...over,
});
const call = (over: Record<string, unknown>) => ({
  _id: new Types.ObjectId(),
  accountId: new Types.ObjectId(),
  provider: 'whatsapp',
  direction: 'outbound',
  status: 'completed',
  endReason: null,
  createdAt: ago(60),
  timestamps: { queuedAt: ago(60), ringingAt: null, answeredAt: null, endedAt: null },
  ...over,
});

const base = {
  mongoPrimary: true,
  queues: {},
  failedBefore: null,
  lastBackupAt: now.toISOString(),
  now,
};

describe('WhatsApp call media readiness (T18B.6)', () => {
  it('System status: media flags, port range, live calls, last setup and last error', async () => {
    expect(await readWhatsAppCallsStatus(env({ WHATSAPP_ENABLED: false }), now)).toBeNull();
    await CallModel.collection.insertMany([
      call({ status: 'in_progress', createdAt: ago(1) }),
      call({
        createdAt: ago(5),
        timestamps: { queuedAt: ago(5), ringingAt: new Date(ago(5).getTime() + 1_200) },
      }),
      call({ status: 'failed', endReason: 'media_timeout', createdAt: ago(10) }),
      call({ status: 'failed', endReason: 'meta_failed', createdAt: ago(20) }),
      call({ status: 'failed', endReason: 'rejected_by_customer', createdAt: ago(3) }),
      call({ provider: 'sip', status: 'failed', endReason: 'media_error', createdAt: ago(2) }),
    ]);
    expect(await readWhatsAppCallsStatus(env(), now)).toEqual({
      mediaEnabled: true,
      publicIpSet: true,
      portRange: '40000-40999',
      liveCalls: 1,
      lastSetupMs: 1_200,
      lastError: { reason: 'media_timeout', at: ago(10).toISOString() },
      failedSetups15m: 1,
    });
    expect(
      await readWhatsAppCallsStatus(env({ WA_MEDIA_PUBLIC_IP: undefined }), now),
    ).toMatchObject({ publicIpSet: false });
  });

  it('health rules: no public IP in production; 3 failed setups in 15 minutes', () => {
    const wa = { mediaEnabled: true, publicIpSet: false, failedSetups15m: 0 };
    expect(healthIssues({ ...base, env: 'production', whatsappCalls: wa })).toEqual([
      'wa-media-no-public-ip',
    ]);
    expect(healthIssues({ ...base, env: 'staging', whatsappCalls: wa })).toEqual([]);
    expect(
      healthIssues({
        ...base,
        env: 'production',
        whatsappCalls: { ...wa, mediaEnabled: false },
      }),
    ).toEqual([]);
    const failing = { mediaEnabled: true, publicIpSet: true, failedSetups15m: 3 };
    expect(HEALTH_LIMITS.waCallSetupFailures).toBe(3);
    expect(healthIssues({ ...base, whatsappCalls: failing })).toEqual(['wa-call-setup-failing']);
    expect(healthIssues({ ...base, whatsappCalls: { ...failing, failedSetups15m: 2 } })).toEqual(
      [],
    );
    expect(healthIssues({ ...base, whatsappCalls: null })).toEqual([]);
  });
});
