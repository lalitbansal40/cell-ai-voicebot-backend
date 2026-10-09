/**
 * DEV ONLY — demo AI data for an account (used by `npm run db:seed`):
 * "Recovery Bot (Hinglish)" (active, knowledge linked) and "Payment Reminder"
 * (inactive) from the templates, the "Demo Finance FAQ" knowledge base with
 * the three sample documents ingested through the real ingest code (the env's
 * AI provider — fake unless AI_PROVIDER=openai), and mock payment records for
 * the demo contacts (half paid, half unpaid, every fifth partial).
 * Idempotent: agents / knowledge bases / sources are matched by name or title.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import type { AiJobs } from '../src/core/ai/jobs';
import { KNOWLEDGE_CONTENT_TYPES } from '../src/core/ai/parsers';
import type { AiProvider } from '../src/core/ai/types';
import { storageKey, type StorageProvider } from '../src/core/storage';
import { AiAgentModel } from '../src/db/models/ai-agent.model';
import { KnowledgeBaseModel } from '../src/db/models/knowledge-base.model';
import {
  KnowledgeSourceModel,
  type KnowledgeFileType,
} from '../src/db/models/knowledge-source.model';
import { MockPaymentRecordModel } from '../src/db/models/mock-payment-record.model';
import { findTemplate } from '../src/modules/ai-agents/templates';
import { ingestSource } from '../src/modules/knowledge/ingest.job';

import { DEMO_CONTACT_COUNT, demoPhone } from './seed-contacts';

const SAMPLES = path.resolve(__dirname, '../docs/samples/knowledge');
const SAMPLE_FILES: { file: string; type: KnowledgeFileType }[] = [
  { file: 'faq.txt', type: 'txt' },
  { file: 'payment-policy.pdf', type: 'pdf' },
  { file: 'loan-terms.docx', type: 'docx' },
];
export const SEED_KB_NAME = 'Demo Finance FAQ';
export const SEED_AGENTS = [
  {
    name: 'Recovery Bot (Hinglish)',
    templateKey: 'loan_recovery_hinglish',
    active: true,
    knowledge: true,
  },
  { name: 'Payment Reminder', templateKey: 'payment_reminder', active: false, knowledge: false },
] as const;

export interface AiSeedResult {
  agents: number;
  sources: number;
  ready: number;
  mockPayments: number;
}

/** Mock answer for demo contact `i`: every 5th partial, even paid, odd unpaid. */
export const mockPaymentFor = (i: number) => {
  const status = i % 5 === 0 ? 'partial' : i % 2 === 0 ? 'paid' : 'unpaid';
  return {
    status,
    amountMicros: (2_000 + i * 100) * 1_000_000,
    paidOn: status === 'unpaid' ? null : `2026-10-${String((i % 8) + 1).padStart(2, '0')}`,
  } as const;
};

export const seedAi = async (
  accountId: Types.ObjectId,
  deps: {
    env: Pick<Env, 'APP_URL' | 'MOCK_APIS_ENABLED' | 'OPENAI_TEXT_MODEL'>;
    ownerId: Types.ObjectId;
    storage: StorageProvider;
    provider: AiProvider;
    jobs: AiJobs;
  },
): Promise<AiSeedResult> => {
  // knowledge base + the three samples
  const kb =
    (await KnowledgeBaseModel.findOne({ accountId, name: SEED_KB_NAME }).lean()) ??
    (
      await KnowledgeBaseModel.create({
        accountId,
        name: SEED_KB_NAME,
        description: 'Payment methods, late fee, policy and loan terms (sample documents)',
        createdBy: deps.ownerId,
      })
    ).toObject({ transform: false });
  let sources = 0;
  let ready = 0;
  for (const { file, type } of SAMPLE_FILES) {
    const existing = await KnowledgeSourceModel.findOne({
      accountId,
      kbId: kb._id,
      title: file,
    }).lean();
    if (existing?.status === 'ready') {
      ready += 1;
      continue;
    }
    let source = existing;
    if (!source) {
      const _id = new Types.ObjectId();
      const key = storageKey({
        accountId: accountId.toString(),
        area: 'knowledge',
        id: _id.toString(),
        ext: type,
      });
      const data = readFileSync(path.join(SAMPLES, file));
      await deps.storage.put(key, data, { contentType: KNOWLEDGE_CONTENT_TYPES[type] });
      source = (
        await KnowledgeSourceModel.create({
          _id,
          accountId,
          kbId: kb._id,
          kind: 'file',
          title: file,
          fileType: type,
          fileKey: key,
          bytes: data.length,
          version: 1,
          createdBy: deps.ownerId,
        })
      ).toObject({ transform: false });
      sources += 1;
    }
    const out = await ingestSource(
      {
        accountId: accountId.toString(),
        kbId: kb._id.toString(),
        sourceId: source._id.toString(),
        version: source.version,
      },
      { provider: deps.provider, storage: deps.storage, jobs: deps.jobs },
    );
    if (out.status === 'ready') ready += 1;
  }

  // agents from the templates
  let agents = 0;
  for (const seed of SEED_AGENTS) {
    if (await AiAgentModel.findOne({ accountId, name: seed.name }).select({ _id: 1 }).lean())
      continue;
    const template = findTemplate(deps.env, seed.templateKey);
    if (!template) throw new Error(`Unknown template ${seed.templateKey}`);
    await AiAgentModel.create({
      ...template.values,
      accountId,
      name: seed.name,
      templateKey: template.key,
      isActive: seed.active,
      allowedVariables: ['name', 'loan_amount', 'due_date'],
      model: { textModel: deps.env.OPENAI_TEXT_MODEL },
      knowledge: {
        knowledgeBaseIds: seed.knowledge ? [kb._id] : [],
        topK: 4,
        minScoreHundredths: 35,
      },
      createdBy: deps.ownerId,
      updatedBy: deps.ownerId,
    });
    agents += 1;
  }

  // mock payment API answers for the demo contacts
  let mockPayments = 0;
  for (let i = 1; i <= DEMO_CONTACT_COUNT; i += 1) {
    const phoneE164 = demoPhone(i);
    const loanId = `DEMO-${String(i).padStart(4, '0')}`;
    const res = await MockPaymentRecordModel.updateOne(
      { phoneE164, loanId },
      { $setOnInsert: { phoneE164, loanId, ...mockPaymentFor(i) } },
      { upsert: true },
    );
    mockPayments += res.upsertedCount;
  }
  return { agents, sources, ready, mockPayments };
};
