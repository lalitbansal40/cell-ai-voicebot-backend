import { Router } from 'express';
import type { Store } from 'express-rate-limit';

import type { Env } from './config/env';
import { createFakeProvider, type AiProvider } from './core/ai';
import { unavailableAiJobs, type AiJobs } from './core/ai/jobs';
import { secretBoxKey } from './core/ai/secret-box';
import { unavailableBillingJobs, type BillingJobs } from './core/billing/jobs';
import { createPaymentProvider, type PaymentProvider } from './core/payments';
import type { StorageProvider } from './core/storage';
import { createAccountRouter } from './modules/account/account.routes';
import { createAdminRouter } from './modules/admin/admin.routes';
import { createAgentsRouter } from './modules/ai-agents/agents.routes';
import type { FunctionsDeps } from './modules/ai-agents/functions.service';
import { createApiKeysRouter } from './modules/api-keys/api-keys.routes';
import { createAuditRouter } from './modules/audit/audit.routes';
import { createAuthRouter, type AuthRouterDeps } from './modules/auth/auth.routes';
import { createBillingRouter } from './modules/billing/billing.routes';
import { createInvoicesRouter } from './modules/billing/invoices.routes';
import type { CallManager } from './modules/calls/call.service';
import { createCallsRouter } from './modules/calls/calls.routes';
import type { CallRegistry } from './modules/calls/registry';
import {
  createCampaignsRouter,
  type CampaignsRouterDeps,
} from './modules/campaigns/campaigns.routes';
import { createContactExportsRouter } from './modules/contact-exports/contact-exports.routes';
import { createContactImportsRouter } from './modules/contact-imports/contact-imports.routes';
import { createContactListsRouter } from './modules/contact-lists/contact-lists.routes';
import { createContactTagsRouter, createContactsRouter } from './modules/contacts/contacts.routes';
import type { ContactJobs } from './modules/contacts/jobs';
import { createCustomFieldsRouter } from './modules/custom-fields/custom-fields.routes';
import { createDndRouter, createOptOutRouter } from './modules/dnd/dnd.routes';
import { createOpenApiHandler } from './modules/docs/openapi.controller';
import { createFlowAudioRouter } from './modules/flow-audio/flow-audio.routes';
import { createFlowsRouter } from './modules/flows/flows.routes';
import { createKnowledgeRouter } from './modules/knowledge/knowledge.routes';
import { createMockApisRouter } from './modules/mock-apis/mock.routes';
import { createNotificationsRouter } from './modules/notifications/notifications.routes';
import { createWebhooksRouter } from './modules/payments/webhooks.routes';
import { createRbacRouter } from './modules/rbac/rbac.routes';
import { createWsTicketsRouter } from './modules/realtime-tickets/tickets.routes';
import { createSegmentsRouter } from './modules/segments/segments.routes';
import { createSystemRouter } from './modules/system/system.routes';
import { createTeamRouter } from './modules/team/team.routes';
import { createWalletRouter } from './modules/wallet/wallet.routes';
import {
  createMetaWebhooksRouter,
  type MetaWebhooksDeps,
} from './modules/whatsapp/webhooks.routes';

/** Everything under /api/v1. Add each module router here. */
/** What the contact modules need: file storage + the background job queue (Phase 3). */
/** What the wallet / billing modules need (Phase 4). */
/** Phase 9: WhatsApp (built by the server when `WHATSAPP_ENABLED`). */
export type WhatsAppDeps = MetaWebhooksDeps;

export interface BillingDeps {
  payments?: PaymentProvider;
  jobs?: BillingJobs;
  storage?: StorageProvider;
  topupRateLimitStore?: Store;
}

/** What the AI agent / knowledge modules need (Phase 5). */
export interface AiDeps {
  provider: AiProvider;
  jobs?: AiJobs;
  storage?: StorageProvider;
  rateLimitStores?: { playground?: Store; knowledge?: Store; functionTest?: Store };
  /** Test hooks for the custom-function executor (fake resolver / dial / ports). */
  http?: FunctionsDeps['http'];
}

/** What the call flow modules need (Phase 6). */
export interface FlowsDeps {
  rateLimitStores?: { simulator?: Store; audio?: Store };
}

/** The live call runtime (Phase 7) — absent where no voice runs (most tests). */
export interface CallsApiDeps {
  manager: CallManager;
  registry: CallRegistry;
  /** `call.say_text` allowed (dev / tests). */
  textInput: boolean;
  voiceProvider: 'openai' | 'fake';
  /** Web calls limiter store (`rl:callweb:`). */
  webCallStore?: Store;
  /** Single calls limiter store (`rl:callout:`). */
  calloutStore?: Store;
}

export interface ContactsDeps {
  storage?: StorageProvider;
  jobs?: ContactJobs;
}

export const createApiRouter = ({
  env,
  auth = {},
  contacts = {},
  billing = {},
  ai = { provider: createFakeProvider() },
  flows = {},
  calls,
  campaigns = {},
  whatsapp,
}: {
  env: Pick<
    Env,
    | 'APP_URL'
    | 'CORS_ORIGINS'
    | 'NODE_ENV'
    | 'PAYMENT_PROVIDER'
    | 'BILLING_SIMULATOR_ENABLED'
    | 'FAKE_PAYMENT_SECRET'
    | 'RAZORPAY_KEY_ID'
    | 'RAZORPAY_KEY_SECRET'
    | 'RAZORPAY_WEBHOOK_SECRET'
    | 'MOCK_APIS_ENABLED'
    | 'AI_TEXT_MODELS'
    | 'OPENAI_TEXT_MODEL'
    | 'AI_FUNCTIONS_ALLOW_PRIVATE_HOSTS'
    | 'ENCRYPTION_KEY'
    | 'OPENAI_EMBEDDING_MODEL'
    | 'OPENAI_API_KEY'
    | 'VOICE_PROVIDER'
    | 'VOICE_PIPELINE'
    | 'VOICE_TEXT_INPUT_ENABLED'
    | 'OPENAI_REALTIME_MODEL'
    | 'OPENAI_TTS_MODEL'
    | 'OPENAI_TRANSCRIBE_MODEL'
  >;
  auth?: Omit<AuthRouterDeps, 'env'>;
  contacts?: ContactsDeps;
  billing?: BillingDeps;
  ai?: AiDeps;
  flows?: FlowsDeps;
  calls?: CallsApiDeps;
  campaigns?: CampaignsRouterDeps;
  whatsapp?: WhatsAppDeps;
}): Router => {
  const router = Router();
  router.use('/auth', createAuthRouter({ ...auth, env }));
  router.use('/account', createAccountRouter());
  router.use('/team', createTeamRouter());
  router.use('/api-keys', createApiKeysRouter());
  router.use('/audit-logs', createAuditRouter());
  router.use('/admin', createAdminRouter({ env, provider: ai.provider }));
  router.use('/ws', createWsTicketsRouter());
  router.get('/openapi.json', createOpenApiHandler(env.APP_URL));
  router.use('/system', createSystemRouter());
  router.use('/rbac', createRbacRouter());
  router.use('/contacts', createOptOutRouter());
  router.use('/contacts', createContactsRouter({ jobs: contacts.jobs }));
  router.use(
    '/contact-exports',
    createContactExportsRouter({ storage: contacts.storage, jobs: contacts.jobs }),
  );
  router.use('/dnd-entries', createDndRouter());
  router.use('/contact-tags', createContactTagsRouter());
  router.use('/contact-lists', createContactListsRouter({ jobs: contacts.jobs }));
  router.use('/segments', createSegmentsRouter());
  router.use(
    '/wallet',
    createWalletRouter({
      payments: billing.payments ?? createPaymentProvider(env),
      jobs: billing.jobs ?? unavailableBillingJobs,
      ...(billing.topupRateLimitStore ? { rateLimitStore: billing.topupRateLimitStore } : {}),
    }),
  );
  router.use('/billing', createBillingRouter());
  router.use('/invoices', createInvoicesRouter({ storage: billing.storage }));
  router.use('/notifications', createNotificationsRouter());
  if (whatsapp?.ctx.env.WHATSAPP_ENABLED) {
    router.use('/webhooks/meta', createMetaWebhooksRouter(whatsapp));
  }
  router.use(
    '/webhooks',
    createWebhooksRouter({
      payments: billing.payments ?? createPaymentProvider(env),
      jobs: billing.jobs ?? unavailableBillingJobs,
    }),
  );
  router.use(
    '/contact-imports',
    createContactImportsRouter({ storage: contacts.storage, jobs: contacts.jobs }),
  );
  router.use('/custom-fields', createCustomFieldsRouter({ jobs: contacts.jobs }));
  router.use(
    '/agents',
    createAgentsRouter({
      env,
      provider: ai.provider,
      secretKey: secretBoxKey(env),
      ...(ai.http ? { http: ai.http } : {}),
      ...(ai.rateLimitStores?.functionTest
        ? { functionTestStore: ai.rateLimitStores.functionTest }
        : {}),
      ...(ai.rateLimitStores?.playground ? { playgroundStore: ai.rateLimitStores.playground } : {}),
    }),
  );
  router.use(
    '/knowledge-bases',
    createKnowledgeRouter({
      env,
      provider: ai.provider,
      jobs: ai.jobs ?? unavailableAiJobs,
      ...(ai.storage ? { storage: ai.storage } : {}),
      ...(ai.http?.extraPorts ? { extraPorts: ai.http.extraPorts } : {}),
      ...(ai.rateLimitStores?.knowledge ? { sourcesStore: ai.rateLimitStores.knowledge } : {}),
    }),
  );
  router.use(
    '/flows',
    createFlowsRouter({
      env,
      secretKey: secretBoxKey(env),
      provider: ai.provider,
      ...(ai.http?.extraPorts ? { extraPorts: ai.http.extraPorts } : {}),
      ...(ai.http ? { http: { ...ai.http } } : {}),
      ...(flows.rateLimitStores?.simulator
        ? { simulatorStore: flows.rateLimitStores.simulator }
        : {}),
    }),
  );
  router.use(
    '/flow-audio',
    createFlowAudioRouter({
      ...(ai.storage ? { storage: ai.storage } : {}),
      ...(flows.rateLimitStores?.audio ? { uploadStore: flows.rateLimitStores.audio } : {}),
    }),
  );
  router.use('/campaigns', createCampaignsRouter(campaigns));
  if (calls) {
    router.use(
      '/calls',
      createCallsRouter({
        env,
        secretKey: secretBoxKey(env),
        ...(ai.http?.extraPorts ? { extraPorts: ai.http.extraPorts } : {}),
        storage: ai.storage,
        ...calls,
      }),
    );
  }
  if (env.MOCK_APIS_ENABLED) router.use('/mock', createMockApisRouter());
  return router;
};
