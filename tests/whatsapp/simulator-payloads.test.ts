import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';

import {
  createFakeMetaClient,
  WEBHOOK_OBJECT,
  WEBHOOK_VALUE_SCHEMAS,
  webhookEnvelopeSchema,
} from '../../src/core/meta';
import {
  applySimulatorEffects,
  buildSimulatorPayload,
  SIMULATOR_KINDS,
} from '../../src/modules/whatsapp/simulator';

const channel = {
  wabaId: 'fake_waba_aaaaaaaaaaaa',
  phoneNumberId: 'fake_phone_aaaaaaaaaaaa',
  displayPhoneNumber: '+91 90000 12345',
  verifiedName: 'Test Business',
};

describe('simulator payloads', () => {
  it.each(SIMULATOR_KINDS)('%s is a valid Meta webhook', (kind) => {
    const envelope = webhookEnvelopeSchema.parse(
      buildSimulatorPayload(kind, channel, 1_761_120_000),
    );
    expect(envelope.object).toBe(WEBHOOK_OBJECT);
    const change = envelope.entry[0]?.changes[0];
    expect(envelope.entry[0]?.id).toBe(channel.wabaId);
    const schema = WEBHOOK_VALUE_SCHEMAS[change?.field as keyof typeof WEBHOOK_VALUE_SCHEMAS];
    expect(schema.safeParse(change?.value).success).toBe(true);
  });

  it('messages get fresh ids; channels without a name / number still build', () => {
    const a = JSON.stringify(buildSimulatorPayload('inbound_text', channel));
    const b = JSON.stringify(buildSimulatorPayload('inbound_text', channel));
    expect(a).not.toBe(b);
    const bare = buildSimulatorPayload('name_approved', {
      ...channel,
      verifiedName: null,
      displayPhoneNumber: null,
      phoneNumberId: null,
    });
    expect(JSON.stringify(bare)).toContain('Test Business');
  });

  it('account updates of a WABA without a number leave `phone_number` out (schema-valid)', () => {
    for (const kind of [
      'restricted',
      'unrestricted',
      'token_revoked',
      'payment_method_added',
    ] as const) {
      const update = webhookEnvelopeSchema.parse(
        buildSimulatorPayload(kind, { ...channel, displayPhoneNumber: null }),
      );
      const value = update.entry[0]?.changes[0]?.value as Record<string, unknown>;
      expect(value).not.toHaveProperty('phone_number');
      expect(WEBHOOK_VALUE_SCHEMAS.account_update.safeParse(value).success, kind).toBe(true);
    }
  });

  it('effects update the fake Meta', async () => {
    const calls: string[] = [];
    const fake = {
      ...createFakeMetaClient({ redis: {} as Redis, appSecret: 's' }),
      patchPhone: (_id: string, patch: Record<string, string>) => (
        calls.push(`patch:${JSON.stringify(patch)}`),
        Promise.resolve()
      ),
      revokeToken: () => (calls.push('revoke'), Promise.resolve()),
      addPaymentMethod: () => (calls.push('funded'), Promise.resolve()),
      addPhoneNumber: () => (calls.push('number'), Promise.resolve()),
    };
    for (const kind of SIMULATOR_KINDS) await applySimulatorEffects(fake, kind, channel, 'tok');
    await applySimulatorEffects(fake, 'token_revoked', { ...channel, phoneNumberId: null }, null);
    expect(calls).toEqual([
      'patch:{"quality_rating":"YELLOW","messaging_limit_tier":"TIER_250"}',
      'patch:{"quality_rating":"GREEN","messaging_limit_tier":"TIER_10K"}',
      'patch:{"quality_rating":"RED","messaging_limit_tier":"TIER_250"}',
      'patch:{"name_status":"APPROVED","new_name_status":"NONE"}',
      'patch:{"new_name_status":"DECLINED"}',
      'revoke',
      'funded',
      'number',
    ]);
  });
});
