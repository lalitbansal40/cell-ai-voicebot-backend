import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  allocationSchema,
  businessesSchema,
  creditLineAttachSchema,
  debugTokenSchema,
  graphError,
  meSchema,
  normalizeQuality,
  normalizeTier,
  oauthTokenSchema,
  ownedWabasSchema,
  phoneListSchema,
  phoneNumberIdOf,
  phoneSchema,
  successSchema,
  syncRequestSchema,
  toAllocation,
  toBusinesses,
  toDebugToken,
  toPhone,
  toWaba,
  wabaSchema,
  WEBHOOK_FIELDS,
  WEBHOOK_OBJECT,
  WEBHOOK_VALUE_SCHEMAS,
  webhookEnvelopeSchema,
} from '../../src/core/meta';

const DIR = join(__dirname, '../fixtures/meta');
const load = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

const GRAPH_SCHEMAS = {
  'graph-oauth-token.json': oauthTokenSchema,
  'graph-debug-token.json': debugTokenSchema,
  'graph-me-wabas.json': ownedWabasSchema,
  'graph-me-businesses.json': businessesSchema,
  'graph-waba.json': wabaSchema,
  'graph-phone-numbers.json': phoneListSchema,
  'graph-phone-number.json': phoneSchema,
  'graph-success.json': successSchema,
  'graph-me.json': meSchema,
  'graph-credit-line-attach.json': creditLineAttachSchema,
  'graph-allocation.json': allocationSchema,
  'graph-smb-app-data.json': syncRequestSchema,
} as const;

const PHASE_10_GRAPH = new Set([
  'graph-message-sent.json',
  'graph-media-upload.json',
  'graph-media-url.json',
  'graph-business-profile.json',
  'graph-block-users.json',
  'graph-unblock-users.json',
  'graph-upload-session.json',
  'graph-upload-handle.json',
]);

const PHASE_11_FIXTURE =
  /^(templates-|user-preferences-|pricing-|graph-templates-|graph-template-created|graph-pricing-analytics)/;
/** Phase 12 (calling) — parsed in tests/calls-wa/meta-call-schemas.test.ts. */
const PHASE_12_FIXTURE =
  /^(calls-|call-permission-reply-|account-settings-update|account-update-calling-|graph-call-|graph-phone-settings)/;

describe('Meta fixtures', () => {
  it('every fixture is covered and documented', () => {
    const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
    const globs = [...readme.matchAll(/`([a-z-]+)-\*\.json`/g)].map(
      (m) => new RegExp(`^${m[1] ?? ''}-[a-z-]+\\.json$`),
    );
    for (const file of files) {
      const documented =
        readme.includes(`\`${file}\``) ||
        globs.some((glob) => glob.test(file)) ||
        readme.includes(`\`-${/-([a-z]+)\.json$/.exec(file)?.[1] ?? ''}\``);
      expect(documented, file).toBe(true);
      // Phase 10 fixtures (messages / statuses / messaging Graph answers) are parsed in
      // tests/inbox/meta-message-schemas.test.ts
      expect(
        file.startsWith('graph-error-') ||
          file in GRAPH_SCHEMAS ||
          file.startsWith('webhook-') ||
          file.startsWith('messages-') ||
          file.startsWith('statuses-') ||
          PHASE_10_GRAPH.has(file) ||
          // Phase 11 (templates / pricing) — parsed in tests/templates/meta-*.test.ts
          PHASE_11_FIXTURE.test(file) ||
          PHASE_12_FIXTURE.test(file),
        file,
      ).toBe(true);
    }
  });

  it.each(Object.entries(GRAPH_SCHEMAS))('%s parses', (file, schema) => {
    expect(schema.safeParse(load(file)).success).toBe(true);
  });

  it('graph error fixtures map to the right flags', () => {
    expect(graphError(401, load('graph-error-token-expired.json')).tokenInvalid).toBe(true);
    expect(graphError(400, load('graph-error-rate-limit.json')).retryable).toBe(true);
    expect(graphError(400, load('graph-error-pin-mismatch.json')).code).toBe(133005);
  });

  it.each(files.filter((f) => f.startsWith('webhook-')))('%s parses (envelope + value)', (file) => {
    const envelope = webhookEnvelopeSchema.parse(load(file));
    expect(envelope.object).toBe(WEBHOOK_OBJECT);
    for (const entry of envelope.entry) {
      for (const change of entry.changes) {
        expect(WEBHOOK_FIELDS).toContain(change.field);
        const schema = WEBHOOK_VALUE_SCHEMAS[change.field as keyof typeof WEBHOOK_VALUE_SCHEMAS];
        if (schema) expect(schema.safeParse(change.value).success, file).toBe(true);
      }
    }
  });
});

describe('Meta mappers', () => {
  it('debug token → granted WABA ids, expiry, user', () => {
    const info = toDebugToken(debugTokenSchema.parse(load('graph-debug-token.json')));
    expect(info).toEqual({
      isValid: true,
      type: 'SYSTEM_USER',
      appId: '1000000000000001',
      userId: '2000000000000001',
      expiresAt: null,
      scopes: [
        'business_management',
        'whatsapp_business_management',
        'whatsapp_business_messaging',
      ],
      grantedWabaIds: ['102290129340398'],
    });
    const expiring = toDebugToken(
      debugTokenSchema.parse({ data: { is_valid: false, expires_at: 1_761_120_000 } }),
    );
    expect(expiring).toMatchObject({
      isValid: false,
      expiresAt: new Date(1_761_120_000_000),
      scopes: [],
      grantedWabaIds: [],
      userId: null,
    });
  });

  it('WABA, phone, businesses, allocation', () => {
    expect(toWaba(wabaSchema.parse(load('graph-waba.json')))).toMatchObject({
      currency: 'INR',
      businessId: '3000000000000001',
      businessName: 'Test Business',
      primaryFundingId: '4000000000000001',
      templateNamespace: 'c8ae5f90_307a_ca4c_b8f6_d1e2a2573574',
    });
    expect(toWaba(wabaSchema.parse({ id: 5 }))).toMatchObject({
      id: '5',
      businessId: null,
      primaryFundingId: null,
    });
    expect(toPhone(phoneSchema.parse(load('graph-phone-number.json')))).toMatchObject({
      qualityRating: 'GREEN',
      messagingLimitTier: 'TIER_1K',
      throughputLevel: 'STANDARD',
      isOnBizApp: false,
    });
    expect(toPhone(phoneSchema.parse({ id: '1' }))).toMatchObject({
      qualityRating: 'UNKNOWN',
      messagingLimitTier: null,
      isOfficialBusinessAccount: false,
      throughputLevel: null,
    });
    expect(toBusinesses(businessesSchema.parse({ data: [{ id: '1' }] }))).toEqual([
      { id: '1', name: null, wabas: [] },
    ]);
    expect(toAllocation(allocationSchema.parse({ id: '9' }))).toEqual({
      id: '9',
      receivingCredentialId: null,
    });
  });

  it('normalizes quality and tiers', () => {
    expect(normalizeQuality('yellow')).toBe('YELLOW');
    expect(normalizeQuality('NA')).toBe('UNKNOWN');
    expect(normalizeQuality(null)).toBe('UNKNOWN');
    expect(normalizeTier('tier_250')).toBe('TIER_250');
    // Phase 12: Meta's 2,000 tier (late 2025) is known; others stay unknown
    expect(normalizeTier('TIER_2K')).toBe('TIER_2K');
    expect(normalizeTier('TIER_5K')).toBeNull();
    expect(normalizeTier(undefined)).toBeNull();
  });

  it('phoneNumberIdOf reads the routing metadata', () => {
    const messages = webhookEnvelopeSchema.parse(load('webhook-messages-text.json'));
    expect(phoneNumberIdOf(messages.entry[0]?.changes[0]?.value)).toBe('106540352242922');
    const account = webhookEnvelopeSchema.parse(load('webhook-account-update-ban.json'));
    expect(phoneNumberIdOf(account.entry[0]?.changes[0]?.value)).toBeNull();
    expect(phoneNumberIdOf(null)).toBeNull();
  });

  it('allows unknown keys, rejects missing required ones', () => {
    expect(phoneSchema.parse({ id: '1', brand_new_field: 1 })).toHaveProperty('brand_new_field', 1);
    expect(
      WEBHOOK_VALUE_SCHEMAS.phone_number_quality_update.safeParse({ event: 'UPGRADE' }).success,
    ).toBe(false);
    expect(webhookEnvelopeSchema.parse({ object: 'page' })).toEqual({ object: 'page', entry: [] });
  });
});
