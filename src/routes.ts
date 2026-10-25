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
import { createInboxDisabledRouter, createInboxRouter } from './modules/inbox/inbox.routes';
import { unavailableInboxJobs, type InboxJobs } from './modules/inbox/jobs';
import { createInboxSettingsRouter } from './modules/inbox/settings.routes';
import { createKnowledgeRouter } from './modules/knowledge/knowledge.routes';
import { createMockApisRouter } from './modules/mock-apis/mock.routes';
import { createNotificationsRouter } from './modules/notifications/notifications.routes';
import { createWebhooksRouter } from './modules/payments/webhooks.routes';
import { createRbacRouter } from './modules/rbac/rbac.routes';
import { createWsTicketsRouter } from './modules/realtime-tickets/tickets.routes';
import { createSegmentsRouter } from './modules/segments/segments.routes';
import { createSystemRouter } from './modules/system/system.routes';
import { createTeamRouter } from './modules/team/team.routes';
import { unavailableTemplateJobs, type TemplateJobs } from './modules/templates/jobs';
import { createTemplatesRouter } from './modules/templates/templates.routes';
import { createWalletRouter } from './modules/wallet/wallet.routes';
import { createDevSimulatorRouter } from './modules/whatsapp/dev-simulator.routes';
import { createMetaCallbacksRouter } from './modules/whatsapp/meta-callbacks.routes';
import { createBusinessProfileRouter } from './modules/whatsapp/profile.routes';
import {
  createMetaWebhooksRouter,
  type MetaWebhooksDeps,
} from './modules/whatsapp/webhooks.routes';
import {
  createWhatsAppDisabledRouter,
  createWhatsAppRouter,
} from './modules/whatsapp/whatsapp.routes';
import { createWhatsAppService } from './modules/whatsapp/whatsapp.service';
import { createPricePreviewRouter } from './modules/whatsapp-billing/price-preview.routes';
import { createCallingRouter } from './modules/whatsapp-calling/calling.routes';
import type { CallingJobs } from './modules/whatsapp-calling/jobs';
import type { CallingRuntime } from './modules/whatsapp-calling/runtime';
import { createInboxCallingHook } from './modules/whatsapp-calling/webhooks';

/** Everything under /api/v1. Add each module router here. */
/** What the contact modules need: file storage + the background job queue (Phase 3). */
/** What the wallet / billing modules need (Phase 4). */
/** Phase 9: WhatsApp (built by the server when `WHATSAPP_ENABLED`). */
export type WhatsAppDeps = MetaWebhooksDeps & {
  /** `rl:wa-connect:` limiter store (MemoryStore when omitted). */
  connectRateLimitStore?: Store;
  /** Phase 10 inbox: jobs on the `whatsapp` queue (send, media, receipts). */
  inboxJobs?: InboxJobs;
  /** Inbox uploads / media (the app's file storage). */
  storage?: StorageProvider;
  /** `rl:inbox-send:` / `rl:inbox-upload:` stores. */
  inboxSendRateLimitStore?: Store;
  inboxUploadRateLimitStore?: Store;
  /** Phase 11: template jobs on the `whatsapp` queue (sync after a connect). */
  templateJobs?: TemplateJobs;
  /** `rl:templates:` / `rl:template-sync:` stores. */
  templatesRateLimitStore?: Store;
  templateSyncRateLimitStore?: Store;
  /** Phase 12: calling jobs on the `whatsapp` queue (settings sync after a connect). */
  callingJobs?: CallingJobs;
  calling?: CallingRuntime;
};

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
  if (whatsapp?.ctx.env.WHATSAPP_ENABLED) {
    router.use(
      '/account/inbox-settings',
      createInboxSettingsRouter({ retentionDays: whatsapp.ctx.env.INBOX_RETENTION_DAYS }),
    );
  }
  router.use('/account', createAccountRouter());
  router.use('/team', createTeamRouter());
  router.use('/api-keys', createApiKeysRouter());
  router.use('/audit-logs', createAuditRouter());
  const whatsappRuntime = whatsapp?.ctx.env.WHATSAPP_ENABLED
    ? {
        ...whatsapp,
        service: createWhatsAppService(whatsapp.ctx, {
          onConnected: async (channel) => {
            await whatsapp.templateJobs?.enqueueSync(channel._id.toString(), 'connect');
            // Phase 12: read the new number's call settings from Meta
            await whatsapp.callingJobs?.enqueueSettingsSync(channel._id.toString(), 'connect');
          },
        }),
      }
    : undefined;
  router.use(
    '/admin',
    createAdminRouter({ env, provider: ai.provider, whatsapp: whatsappRuntime }),
  );
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
  if (whatsappRuntime) {
    if (whatsappRuntime.calling)
      router.use(createCallingRouter({ runtime: whatsappRuntime.calling }));
    router.use('/webhooks/meta', createMetaWebhooksRouter(whatsappRuntime));
    router.use('/meta', createMetaCallbacksRouter(whatsappRuntime));
    router.use('/whatsapp', createBusinessProfileRouter(whatsappRuntime.ctx));
    router.use('/whatsapp', createPricePreviewRouter());
    router.use(
      '/whatsapp',
      createTemplatesRouter({
        ctx: whatsappRuntime.ctx,
        jobs: whatsappRuntime.templateJobs ?? unavailableTemplateJobs,
        storage: whatsappRuntime.storage ?? contacts.storage,
        ...(whatsappRuntime.templatesRateLimitStore
          ? { rateLimitStore: whatsappRuntime.templatesRateLimitStore }
          : {}),
        ...(whatsappRuntime.templateSyncRateLimitStore
          ? { syncRateLimitStore: whatsappRuntime.templateSyncRateLimitStore }
          : {}),
      }),
    );
    router.use('/whatsapp', createWhatsAppRouter(whatsappRuntime));
    router.use(
      '/inbox',
      createInboxRouter({
        ctx: whatsappRuntime.ctx,
        ...(whatsappRuntime.calling
          ? { calling: createInboxCallingHook(whatsappRuntime.calling.permissions) }
          : {}),
        storage: whatsappRuntime.storage ?? contacts.storage,
        jobs: whatsappRuntime.inboxJobs ?? unavailableInboxJobs,
        ...(whatsappRuntime.inboxSendRateLimitStore
          ? { sendRateLimitStore: whatsappRuntime.inboxSendRateLimitStore }
          : {}),
        ...(whatsappRuntime.inboxUploadRateLimitStore
          ? { uploadRateLimitStore: whatsappRuntime.inboxUploadRateLimitStore }
          : {}),
      }),
    );
  } else {
    router.use('/whatsapp', createWhatsAppDisabledRouter());
    router.use('/inbox', createInboxDisabledRouter());
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
  if (whatsappRuntime && env.MOCK_APIS_ENABLED && env.NODE_ENV !== 'production') {
    router.use('/dev/meta', createDevSimulatorRouter(whatsappRuntime));
  }
  return router;
};
