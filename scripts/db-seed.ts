/**
 * DEV ONLY — demo data: account "Demo Finance" with one user per role, demo
 * contacts (fields, list, segment, DND — scripts/seed-contacts.ts), demo
 * billing (profile, ₹1,000 credit, simulated calls, a fake top-up + invoice —
 * scripts/seed-billing.ts), demo AI agents + knowledge base + mock payment
 * records (scripts/seed-ai.ts), the demo flows (scripts/seed-flows.ts), two finished
 * demo calls run through the real call runtime on fake voice (scripts/seed-calls.ts),
 * a connected fake WhatsApp number with three simulated events (scripts/seed-whatsapp.ts)
 * and a platform superadmin. Needs Mongo + Redis (the
 * invoice PDF is rendered by the billing worker of a running dev server).
 * Idempotent; existing users are left as they are.
 * Password: SEED_PASSWORD, else a random one printed once. Refuses in production.
 */
import { getEnv } from '../src/config/env';
import { createAiProvider, createFakeProvider } from '../src/core/ai';
import { unavailableAiJobs } from '../src/core/ai/jobs';
import { queueBillingJobs } from '../src/core/billing/jobs';
import { QUEUES } from '../src/core/queues/names';
import { closeAllQueues, createQueue } from '../src/core/queues/queue-factory';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { createStorage } from '../src/core/storage';
import { AccountModel } from '../src/db/models/account.model';
import { UserModel } from '../src/db/models/user.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { randomToken } from '../src/modules/auth/hmac';
import { getPlatformAccount, upsertActiveUser } from '../src/modules/auth/user-setup';
import type { SystemRoleKey } from '../src/modules/rbac/system-roles';
import { getLogger } from '../src/shared/logger';

import { SEED_KB_NAME, seedAi } from './seed-ai';
import { seedBilling } from './seed-billing';
import { SEED_CALL_MARKS, seedCalls } from './seed-calls';
import { SEED_CAMPAIGN_NAMES, SEED_CAMPAIGN_SEGMENT, seedCampaigns } from './seed-campaigns';
import { DEMO_CONTACT_COUNT, seedContacts } from './seed-contacts';
import { SEED_FLOW_NAMES, seedFlows } from './seed-flows';
import { SEED_WHATSAPP_NUMBER, seedWhatsApp } from './seed-whatsapp';

const ROLES: SystemRoleKey[] = ['owner', 'admin', 'manager', 'agent', 'viewer'];

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('db:seed is disabled in production');
  const password = env.SEED_PASSWORD ?? `Seed-${randomToken(9)}`;
  await connectMongo(env, getLogger());
  try {
    const account =
      (await AccountModel.findOne({ slug: 'demo-finance' })) ??
      (await AccountModel.create({ name: 'Demo Finance', slug: 'demo-finance' }));
    const created: string[] = [];
    for (const role of ROLES) {
      const email = `${role}@demo.local`;
      const res = await upsertActiveUser({
        accountId: account._id,
        roleKey: role,
        email,
        name: `Demo ${role[0]?.toUpperCase()}${role.slice(1)}`,
        password,
      });
      if (res.created) created.push(email);
    }
    const owner = await UserModel.findOne({ email: 'owner@demo.local' }).select({ _id: 1 }).lean();
    const demo = await seedContacts(account._id, owner?._id ?? account._id);
    console.info(
      `Contacts: ${demo.fields} fields, list "Demo borrowers" (${DEMO_CONTACT_COUNT} contacts, ${demo.contacts} new), segment "Overdue > 30 days", 2 DND numbers`,
    );
    const platform = await getPlatformAccount();
    const admin = await upsertActiveUser({
      accountId: platform._id,
      roleKey: 'owner',
      email: 'admin@platform.local',
      name: 'Platform Admin',
      password,
      platformRole: 'superadmin',
    });
    if (admin.created) created.push('admin@platform.local');

    const logger = getLogger();
    const jobs = queueBillingJobs(createQueue(QUEUES.billing, { redisUrl: env.REDIS_URL, logger }));
    const billing = await seedBilling(account._id, {
      ownerId: owner?._id ?? account._id,
      adminId: admin.userId,
      jobs,
    });
    console.info(
      `Billing: profile ${billing.profile ? 'set' : 'kept'}, opening credit ${billing.openingCredit ? 'added' : 'already there'}, ${billing.calls} new simulated calls, top-up ${billing.topup ? `paid (invoice ${billing.invoiceNumber ?? '?'})` : 'already paid'}`,
    );

    const ai = await seedAi(account._id, {
      env,
      ownerId: owner?._id ?? account._id,
      storage: createStorage(env, logger),
      provider: createAiProvider(env),
      jobs: unavailableAiJobs,
    });
    console.info(
      `AI: ${ai.agents} new agents ("Recovery Bot (Hinglish)", "Payment Reminder"), knowledge base "${SEED_KB_NAME}" ${ai.ready}/3 sources ready (${ai.sources} new), ${ai.mockPayments} new mock payment records`,
    );

    const flows = await seedFlows(account._id, {
      env,
      ownerId: owner?._id ?? account._id,
      storage: createStorage(env, logger),
    });
    console.info(
      `Flows: ${flows.flows} new ("${SEED_FLOW_NAMES.loan}" published v1, "${SEED_FLOW_NAMES.feedback}" draft), audio "Welcome tone" ${flows.audio ? 'added' : 'kept'}${flows.addedVariables.length ? `, flow variables for missing fields: ${flows.addedVariables.join(', ')}` : ''}`,
    );

    const demoCalls = await seedCalls(account._id, {
      env,
      ownerId: owner?._id ?? account._id,
      storage: createStorage(env, logger),
      redis: getAppRedis(env.REDIS_URL, logger),
      provider: createFakeProvider(), // demo calls never spend on a real model
      logger,
    });
    console.info(
      `Calls: ${demoCalls.calls} new demo calls (${Object.values(SEED_CALL_MARKS).join(', ')}) — fake voice, real runtime`,
    );

    const demoCampaigns = await seedCampaigns(account._id, {
      env,
      ownerId: owner?._id ?? account._id,
      storage: createStorage(env, logger),
      redis: getAppRedis(env.REDIS_URL, logger),
      logger,
    });
    console.info(
      `Campaigns: ${String(demoCampaigns.campaigns)} new ("${SEED_CAMPAIGN_NAMES.done}" ${String(demoCampaigns.calls)} dry-run calls, ${String(demoCampaigns.waiting)} callback(s) waiting; "${SEED_CAMPAIGN_NAMES.draft}"; "${SEED_CAMPAIGN_NAMES.recurring}" paused), segment "${SEED_CAMPAIGN_SEGMENT}" — dry run, never charged`,
    );

    const demoWhatsApp = await seedWhatsApp(account._id, {
      env,
      ownerId: owner?._id ?? account._id,
      redis: getAppRedis(env.REDIS_URL, logger),
      logger,
    });
    console.info(
      demoWhatsApp.skipped
        ? `WhatsApp: skipped (${demoWhatsApp.skipped})`
        : `WhatsApp: ${String(demoWhatsApp.channels)} new demo number (${SEED_WHATSAPP_NUMBER}, fake Meta) + ${String(demoWhatsApp.events)} simulated events`,
    );

    console.info(
      'Seed: account "Demo Finance" (demo-finance) + users <role>@demo.local + admin@platform.local',
    );
    if (created.length) {
      console.info(`Created: ${created.join(', ')}`);
      console.info(
        env.SEED_PASSWORD
          ? 'Password: SEED_PASSWORD from .env'
          : `Password (shown once): ${password}`,
      );
    } else {
      console.info('Nothing new — all seed users already exist.');
    }
  } finally {
    await closeAllQueues();
    await closeAllRedis();
    await disconnectMongo();
  }
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
