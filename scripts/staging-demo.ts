/**
 * STAGING ONLY (Phase 13) — the demo account for Meta's App Review and the team's real
 * checks: "Demo Finance (Review)" with an owner / admin / agent, the demo contacts (fake
 * numbers) plus the team's own test phones, the Loan recovery AI agent + knowledge base +
 * published flow, and test money in the wallet (engine credit). Idempotent. No fake Meta
 * data: the WhatsApp number is connected for real through Embedded Signup.
 *
 * Runs on the staging server in a one-off tools container (deploy/staging/scripts/tools.sh
 * staging:demo) with the server's env file plus:
 *   DEMO_SEED_CONFIRM   the host of APP_URL (a typo can't seed another server)
 *   DEMO_OWNER_EMAIL    the review owner's e-mail (a mailbox the team reads)
 *   DEMO_OWNER_PASSWORD at least 16 characters (never printed; admin / agent get random ones)
 *   DEMO_TEST_PHONES    optional comma list of the team's own E.164 phones
 */
import type { Types } from 'mongoose';

import { getEnv, type Env } from '../src/config/env';
import { createAiProvider, type AiProvider } from '../src/core/ai';
import { unavailableAiJobs } from '../src/core/ai/jobs';
import { credit } from '../src/core/billing/engine';
import { createStorage, type StorageProvider } from '../src/core/storage';
import { AccountModel } from '../src/db/models/account.model';
import { ContactModel } from '../src/db/models/contact.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { randomToken } from '../src/modules/auth/hmac';
import { upsertActiveUser } from '../src/modules/auth/user-setup';
import { buildSearchText, normalizePhone } from '../src/modules/contacts/normalize';
import { runOp, say } from '../src/ops/cli';
import { getLogger } from '../src/shared/logger';

import { SEED_KB_NAME, seedAi } from './seed-ai';
import { seedContacts } from './seed-contacts';
import { SEED_FLOW_NAMES, seedFlows } from './seed-flows';

export const STAGING_DEMO_CONTACT_COUNT = 20;
export const DEMO_ACCOUNT = { name: 'Demo Finance (Review)', slug: 'demo-finance-review' };
export const DEMO_CREDIT_MICROS = 2_000 * 1_000_000;
export const DEMO_CREDIT_KEY = 'staging-demo-credit-v1';

export interface DemoInput {
  confirmHost: string | undefined;
  ownerEmail: string | undefined;
  ownerPassword: string | undefined;
  testPhones: string | undefined;
}

export interface DemoDeps {
  env: Pick<Env, 'NODE_ENV' | 'APP_URL' | 'MOCK_APIS_ENABLED' | 'OPENAI_TEXT_MODEL'>;
  storage: StorageProvider;
  provider: AiProvider;
  /** Tests only: allow outside production. */
  allowNonProduction?: boolean;
  skipKnowledge?: boolean;
}

export interface DemoResult {
  accountId: string;
  usersCreated: string[];
  contacts: number;
  testContacts: number;
  agents: number;
  knowledgeReady: number;
  flows: number;
  credited: boolean;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Checks the guard values; returns the parsed test phones (E.164). */
export const checkDemoInput = (
  input: DemoInput,
  deps: Pick<DemoDeps, 'env' | 'allowNonProduction'>,
) => {
  if (deps.env.NODE_ENV !== 'production' && !deps.allowNonProduction)
    throw new Error('staging:demo runs only with NODE_ENV=production (the staging server)');
  const host = deps.env.APP_URL ? new URL(deps.env.APP_URL).host : '';
  if (!input.confirmHost || input.confirmHost !== host)
    throw new Error('DEMO_SEED_CONFIRM must equal the host of APP_URL');
  if (!input.ownerEmail || !EMAIL.test(input.ownerEmail))
    throw new Error('DEMO_OWNER_EMAIL must be an e-mail address');
  if (!input.ownerPassword || input.ownerPassword.length < 16)
    throw new Error('DEMO_OWNER_PASSWORD must have at least 16 characters');
  const phones = (input.testPhones ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const phone = normalizePhone(p);
      if (!phone.ok) throw new Error('DEMO_TEST_PHONES has a number that is not a valid phone');
      return phone.e164;
    });
  return { phones, ownerEmail: input.ownerEmail.toLowerCase(), password: input.ownerPassword };
};

export const stagingDemo = async (input: DemoInput, deps: DemoDeps): Promise<DemoResult> => {
  const { phones, ownerEmail, password } = checkDemoInput(input, deps);
  const account =
    (await AccountModel.findOne({ slug: DEMO_ACCOUNT.slug })) ??
    (await AccountModel.create(DEMO_ACCOUNT));
  const usersCreated: string[] = [];
  const owner = await upsertActiveUser({
    accountId: account._id,
    roleKey: 'owner',
    email: ownerEmail,
    name: 'Review Owner',
    password,
  });
  if (owner.created) usersCreated.push('owner');
  const [local, domain] = ownerEmail.split('@') as [string, string];
  for (const role of ['admin', 'agent'] as const) {
    // plus-addressed to the same mailbox; random passwords (reset by e-mail when needed)
    const res = await upsertActiveUser({
      accountId: account._id,
      roleKey: role,
      email: `${local}+${role}@${domain}`,
      name: `Review ${role === 'admin' ? 'Admin' : 'Agent'}`,
      password: `Demo-${randomToken(18)}`,
    });
    if (res.created) usersCreated.push(role);
  }
  const ownerId: Types.ObjectId = owner.userId;

  const contacts = await seedContacts(account._id, ownerId, {
    count: STAGING_DEMO_CONTACT_COUNT,
    // NANP 555-0100..0199 are reserved for fictional use. Also block all demo
    // placeholders from calling; only the supplied team phones are callable.
    phone: (i) => `+120255501${String(i - 1).padStart(2, '0')}`,
    blockCalls: true,
  });
  let testContacts = 0;
  for (const [i, phoneE164] of phones.entries()) {
    const name = `Review Tester ${String(i + 1)}`;
    const res = await ContactModel.updateOne(
      { accountId: account._id, phoneE164, deletedAt: null },
      {
        $setOnInsert: {
          accountId: account._id,
          phoneE164,
          name,
          email: null,
          externalId: `REVIEW-${String(i + 1).padStart(2, '0')}`,
          variables: {
            loan_id: `REVIEW-${String(i + 1).padStart(4, '0')}`,
            loan_amount: 50_000 * 1_000_000,
            emi_amount: 2_000 * 1_000_000,
            due_date: new Date().toISOString().slice(0, 10),
            days_past_due: 30,
            branch: 'Review test',
          },
          tags: ['review'],
          listIds: [],
          dnd: false,
          optedOutAt: null,
          consent: { source: 'Team test phone (staging review)', at: new Date() },
          source: { type: 'manual', importJobId: null },
          searchText: buildSearchText({
            name,
            phoneE164,
            externalId: `REVIEW-${String(i + 1).padStart(2, '0')}`,
          }),
          lastCalledAt: null,
          callCount: 0,
          deletedAt: null,
        },
      },
      { upsert: true },
    );
    testContacts += res.upsertedCount;
  }

  // test money first: knowledge ingestion is charged as AI usage
  const credited = await credit({
    accountId: account._id,
    type: 'adjustment',
    amountMicros: DEMO_CREDIT_MICROS,
    ref: { type: 'manual', id: DEMO_CREDIT_KEY },
    idempotencyKey: DEMO_CREDIT_KEY,
    note: 'Staging demo credit (test money)',
    createdBy: ownerId,
  });

  const ai = await seedAi(account._id, {
    env: deps.env,
    ownerId,
    storage: deps.storage,
    provider: deps.provider,
    jobs: unavailableAiJobs,
    ingest: !deps.skipKnowledge,
  });
  const flows = await seedFlows(account._id, { env: deps.env, ownerId, storage: deps.storage });

  return {
    accountId: account._id.toString(),
    usersCreated,
    contacts: contacts.contacts,
    testContacts,
    agents: ai.agents,
    knowledgeReady: ai.ready,
    flows: flows.flows,
    credited: !credited.replay,
  };
};

const main = async (args: string[]): Promise<void> => {
  const env = getEnv();
  const logger = getLogger();
  const skipKnowledge = args.includes('--without-knowledge');
  if (skipKnowledge && new URL(env.APP_URL ?? '').hostname !== 'rehearsal.localhost')
    throw new Error('--without-knowledge is restricted to rehearsal.localhost');
  await connectMongo(env, logger);
  try {
    const out = await stagingDemo(
      {
        confirmHost: process.env.DEMO_SEED_CONFIRM,
        ownerEmail: process.env.DEMO_OWNER_EMAIL,
        ownerPassword: process.env.DEMO_OWNER_PASSWORD,
        testPhones: process.env.DEMO_TEST_PHONES,
      },
      { env, storage: createStorage(env, logger), provider: createAiProvider(env), skipKnowledge },
    );
    say(
      `Demo account "${DEMO_ACCOUNT.name}" ready: users created ${out.usersCreated.join(', ') || 'none (kept)'}; ` +
        `${String(STAGING_DEMO_CONTACT_COUNT)} demo contacts (${String(out.contacts)} new) + ${String(out.testContacts)} new test-phone contacts; ` +
        `${String(out.agents)} new agents, knowledge base "${SEED_KB_NAME}" ${String(out.knowledgeReady)}/3 ready; ` +
        `${String(out.flows)} new flows ("${SEED_FLOW_NAMES.loan}" published); wallet credit ${out.credited ? 'added' : 'already there'}.`,
    );
  } finally {
    await disconnectMongo();
  }
};

if (require.main === module) runOp(main);
