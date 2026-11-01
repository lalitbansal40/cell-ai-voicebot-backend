/**
 * DEV ONLY — Phase 15 integrations for "Demo Finance": a demo API key (`cav_test_…`,
 * printed once), a webhook endpoint to the API's own dev receiver (all events), two
 * after-the-call rules on the seeded EMI template (promise → reminder at the next
 * calling hour; not answered twice → reminder now) and a paused Google Sheet import.
 * Idempotent: everything is found by name / URL first.
 */
import type { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import { ApiKeyModel } from '../src/db/models/api-key.model';
import { ContactListModel } from '../src/db/models/contact-list.model';
import { OutcomeRuleModel } from '../src/db/models/outcome-rule.model';
import { SheetImportModel } from '../src/db/models/sheet-import.model';
import { WebhookEndpointModel } from '../src/db/models/webhook-endpoint.model';
import { WhatsAppTemplateModel } from '../src/db/models/whatsapp-template.model';
import { generateApiKey, PREFIX_LENGTH } from '../src/modules/api-keys/api-keys.service';
import type { ApiKeyScope } from '../src/modules/api-keys/scopes';
import { sha256Hex } from '../src/modules/auth/hmac';
import { devReceiverUrl } from '../src/modules/mock-apis/webhook-receiver';
import { newWebhookSecret } from '../src/modules/webhooks/signing';
import { seal, secretBoxKey } from '../src/shared/crypto/secret-box';

import { SEED_TEMPLATE_NAMES } from './seed-templates';

export const SEED_INTEGRATIONS = {
  keyName: 'Demo integration',
  rules: ['Promise to pay → EMI reminder', 'Not answered twice → EMI reminder'],
  sheet: 'Demo leads sheet (paused)',
} as const;

export const SEED_KEY_SCOPES: ApiKeyScope[] = [
  'contacts:read',
  'contacts:write',
  'calls:read',
  'calls:write',
  'messages:write',
  'templates:read',
  'webhooks:manage',
];

export interface IntegrationSeedDeps {
  env: Pick<Env, 'ENCRYPTION_KEY' | 'NODE_ENV' | 'PORT'>;
  ownerId: Types.ObjectId;
}

export interface IntegrationSeedResult {
  /** The full demo key — only when it was created now (shown once). */
  apiKey: string | null;
  webhook: boolean;
  rules: number;
  sheet: boolean;
  skipped?: string;
}

export const seedIntegrations = async (
  accountId: Types.ObjectId,
  { env, ownerId }: IntegrationSeedDeps,
): Promise<IntegrationSeedResult> => {
  let apiKey: string | null = null;
  if (
    !(await ApiKeyModel.exists({ accountId, name: SEED_INTEGRATIONS.keyName, revokedAt: null }))
  ) {
    apiKey = generateApiKey(false);
    await ApiKeyModel.create({
      accountId,
      name: SEED_INTEGRATIONS.keyName,
      prefix: apiKey.slice(0, PREFIX_LENGTH),
      keyHash: sha256Hex(apiKey),
      scopes: SEED_KEY_SCOPES,
      createdBy: ownerId,
    });
  }

  const url = devReceiverUrl(env);
  let webhook = false;
  if (!(await WebhookEndpointModel.exists({ accountId, url }))) {
    await WebhookEndpointModel.create({
      accountId,
      url,
      description: 'Dev receiver (seed)',
      events: ['*'],
      secretSealed: seal(secretBoxKey(env), newWebhookSecret()),
      createdBy: ownerId,
    });
    webhook = true;
  }

  let sheet = false;
  if (!(await SheetImportModel.exists({ accountId, name: SEED_INTEGRATIONS.sheet }))) {
    const [list] = await ContactListModel.create([
      {
        accountId,
        name: `Google Sheet: ${SEED_INTEGRATIONS.sheet}`,
        source: { type: 'upload', fileName: 'Google Sheet' },
      },
    ]);
    await SheetImportModel.create({
      accountId,
      name: SEED_INTEGRATIONS.sheet,
      url: 'https://docs.google.com/spreadsheets/d/e/2PACX-demo-not-real/pub?output=csv',
      schedule: 'daily',
      mapping: {
        columns: [
          { index: 0, target: 'name' },
          { index: 1, target: 'phone' },
        ],
      },
      listId: list?._id,
      active: false,
      createdBy: ownerId,
    });
    sheet = true;
  }

  const emi = await WhatsAppTemplateModel.findOne({
    accountId,
    name: SEED_TEMPLATE_NAMES.emi,
    status: 'APPROVED',
    deletedAt: null,
  })
    .select({ _id: 1 })
    .lean();
  if (!emi) return { apiKey, webhook, rules: 0, sheet, skipped: 'no approved EMI template' };
  const rules = [
    {
      name: SEED_INTEGRATIONS.rules[0],
      order: 0,
      when: { hasPromise: true },
      send: {
        templateId: emi._id,
        params: [
          { from: 'insights' as const, key: 'promise_amount' },
          { from: 'insights' as const, key: 'promise_date' },
        ],
      },
      timing: { mode: 'next_window_hour' as const },
    },
    {
      name: SEED_INTEGRATIONS.rules[1],
      order: 1,
      when: { notAnsweredInARow: 2 },
      send: {
        templateId: emi._id,
        params: [
          { from: 'contact' as const, key: 'emi_amount' },
          { from: 'contact' as const, key: 'due_date' },
        ],
      },
      timing: { mode: 'now' as const },
    },
  ];
  let created = 0;
  for (const rule of rules) {
    if (await OutcomeRuleModel.exists({ accountId, name: rule.name })) continue;
    await OutcomeRuleModel.create({ accountId, ...rule, createdBy: ownerId });
    created += 1;
  }
  return { apiKey, webhook, rules: created, sheet };
};
