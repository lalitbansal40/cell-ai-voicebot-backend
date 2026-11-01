import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  SEED_INTEGRATIONS,
  SEED_KEY_SCOPES,
  seedIntegrations,
} from '../../scripts/seed-integrations';
import { SEED_TEMPLATE_NAMES } from '../../scripts/seed-templates';
import { ApiKeyModel } from '../../src/db/models/api-key.model';
import { OutcomeRuleModel } from '../../src/db/models/outcome-rule.model';
import { SheetImportModel } from '../../src/db/models/sheet-import.model';
import { WebhookEndpointModel } from '../../src/db/models/webhook-endpoint.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import { sha256Hex } from '../../src/modules/auth/hmac';
import { DEV_RECEIVER_PATH } from '../../src/modules/mock-apis/webhook-receiver';
import { useTestDb } from '../helpers/db';
import { testEnv } from '../helpers/test-app';

useTestDb();
const env = testEnv();

describe('seedIntegrations (Phase 15)', () => {
  it('creates the demo key (shown once), dev-receiver webhook, two rules and a paused sheet — once', async () => {
    const accountId = new Types.ObjectId();
    const ownerId = new Types.ObjectId();
    const emi = await WhatsAppTemplateModel.create({
      accountId,
      wabaId: 'fake_waba_1',
      name: SEED_TEMPLATE_NAMES.emi,
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED',
    });

    const first = await seedIntegrations(accountId, { env, ownerId });
    expect(first).toEqual({
      apiKey: expect.stringMatching(/^cav_test_[0-9A-Za-z]{32}$/) as unknown,
      webhook: true,
      rules: 2,
      sheet: true,
    });
    const key = await ApiKeyModel.findOne({ accountId }).lean();
    expect(key).toMatchObject({ name: SEED_INTEGRATIONS.keyName, scopes: SEED_KEY_SCOPES });
    expect(key?.keyHash).toBe(sha256Hex(first.apiKey ?? ''));
    expect(JSON.stringify(key)).not.toContain(first.apiKey ?? 'x');

    const hook = await WebhookEndpointModel.findOne({ accountId }).select('+secretSealed').lean();
    expect(hook?.url).toBe(`http://127.0.0.1:${String(env.PORT)}${DEV_RECEIVER_PATH}`);
    expect(hook?.events).toEqual(['*']);
    expect(hook?.secretSealed).not.toContain('whsec_');

    const rules = await OutcomeRuleModel.find({ accountId }).sort({ order: 1 }).lean();
    expect(rules.map((r) => r.name)).toEqual([...SEED_INTEGRATIONS.rules]);
    expect(rules[0]?.when.hasPromise).toBe(true);
    expect(rules[0]?.timing.mode).toBe('next_window_hour');
    expect(rules[1]?.when.notAnsweredInARow).toBe(2);
    expect(rules.every((r) => r.send.templateId.equals(emi._id))).toBe(true);

    const sheet = await SheetImportModel.findOne({ accountId }).lean();
    expect(sheet).toMatchObject({ name: SEED_INTEGRATIONS.sheet, active: false });

    expect(await seedIntegrations(accountId, { env, ownerId })).toEqual({
      apiKey: null,
      webhook: false,
      rules: 0,
      sheet: false,
    });
    expect(await ApiKeyModel.countDocuments({ accountId })).toBe(1);
    expect(await WebhookEndpointModel.countDocuments({ accountId })).toBe(1);
    expect(await OutcomeRuleModel.countDocuments({ accountId })).toBe(2);
    expect(await SheetImportModel.countDocuments({ accountId })).toBe(1);
  });

  it('skips the rules without an approved EMI template', async () => {
    const res = await seedIntegrations(new Types.ObjectId(), {
      env,
      ownerId: new Types.ObjectId(),
    });
    expect(res).toMatchObject({ rules: 0, skipped: 'no approved EMI template' });
  });
});
