import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createApp } from './app';
import { getEnv, type Env } from './config/env';
import { createAiProvider } from './core/ai';
import { outgoingPolicy } from './core/ai/ip-guard';
import { queueAiJobs } from './core/ai/jobs';
import { secretBoxKey } from './core/ai/secret-box';
import { queueBillingJobs } from './core/billing/jobs';
import {
  createEmailProvider,
  createEmailService,
  setEmail,
  type EmailJobData,
  type EmailProvider,
} from './core/email';
import { createLifecycle, type Lifecycle } from './core/lifecycle';
import { createMetaClient, type FakeMetaClient } from './core/meta';
import { createPaymentProvider } from './core/payments';
import { QUEUES } from './core/queues/names';
import { closeAllQueues, createQueue, DEFAULT_QUEUE_PREFIX } from './core/queues/queue-factory';
import {
  closeAllRedis,
  createSubscriber,
  getAppRedis,
  pingRedis,
  redactRedisUrl,
} from './core/queues/redis';
import { startAiWorker } from './core/queues/workers/ai.worker';
import { startBillingWorker } from './core/queues/workers/billing.worker';
import { startCampaignsWorker } from './core/queues/workers/campaigns.worker';
import { startContactsWorker } from './core/queues/workers/contacts.worker';
import { startEmailWorker } from './core/queues/workers/email.worker';
import { startMaintenanceWorker } from './core/queues/workers/maintenance.worker';
import { startSystemWorker } from './core/queues/workers/system.worker';
import { startWhatsAppWorker } from './core/queues/workers/whatsapp.worker';
import { createRealtime, setRealtime } from './core/realtime';
import { createStorage } from './core/storage';
import { createMediaServer } from './core/telephony/media-server';
import { AiVoiceController } from './core/voice/ai-session';
import { createVoiceProviders } from './core/voice/providers';
import { TtsCache } from './core/voice/tts-cache';
import {
  connectMongo,
  disconnectMongo,
  pingMongo,
  redactMongoUri,
  syncAllIndexes,
} from './db/mongo';
import { CallManager } from './modules/calls/call.service';
import { createDryRunPrograms } from './modules/calls/dry-run';
import { CallRegistry } from './modules/calls/registry';
import { createScriptFactory } from './modules/calls/scripts';
import { authorizeTopic } from './modules/calls/topic-auth';
import { CampaignDispatcher } from './modules/campaigns/dispatcher';
import { queueCampaignExports, queueCampaignJobs, wireCampaigns } from './modules/campaigns/jobs';
import { resetProgressThrottle } from './modules/campaigns/progress';
import { DialRate } from './modules/campaigns/slots';
import { queueContactJobs } from './modules/contacts/jobs';
import { queueInboxJobs } from './modules/inbox/jobs';
import { queueTemplateJobs } from './modules/templates/jobs';
import type { CallsFastPathEvent } from './modules/whatsapp/context';
import { connectFakeStatusWebhooks } from './modules/whatsapp/fake-statuses';
import { queueWhatsAppJobs } from './modules/whatsapp/jobs';
import { createWhatsAppService } from './modules/whatsapp/whatsapp.service';
import { createWhatsAppBillingHook } from './modules/whatsapp-billing/billing-hook';
import { CallControlBus } from './modules/whatsapp-calling/bus';
import { queueCallingJobs } from './modules/whatsapp-calling/jobs';
import { createCallingRuntime } from './modules/whatsapp-calling/runtime';
import { getLogger, type Logger } from './shared/logger';
import { createRedisRateLimitStore } from './shared/middlewares/rate-limit';

export interface RunningServer {
  server: Server;
  lifecycle: Lifecycle;
  /** Actual listening port (differs from env.PORT when `port: 0`). */
  port: number;
}

/** Overrides for tests (e2e). Production calls `startServer()` with none. */
export interface StartServerOptions {
  env?: Env;
  logger?: Logger;
  /** Listen port; `0` = random free port. Default `env.PORT`. */
  port?: number;
  /** SIGINT/SIGTERM handlers (default true; tests call `lifecycle.shutdown()`). */
  installSignalHandlers?: boolean;
  /** BullMQ key prefix (default `cav`) — tests isolate their jobs. */
  queuePrefix?: string;
  /** Email provider override (default from EMAIL_DRIVER). */
  emailProvider?: EmailProvider;
  /** Called after shutdown (default `process.exit`). */
  exit?: (code: number) => void;
}

const FORCE_CLOSE_AFTER_MS = 5_000;

/** Validates env, builds the app, listens and wires graceful shutdown. */
export const startServer = async (options: StartServerOptions = {}): Promise<RunningServer> => {
  const env = options.env ?? getEnv();
  const logger = options.logger ?? getLogger();
  const lifecycle = createLifecycle(logger, { exit: options.exit });
  const prefix = options.queuePrefix ?? DEFAULT_QUEUE_PREFIX;
  const queueDeps = { redisUrl: env.REDIS_URL, logger, prefix };

  try {
    await connectMongo(env, logger);
  } catch (err) {
    logger.fatal(
      { err, target: redactMongoUri(env.MONGODB_URI) },
      'MongoDB not reachable — run "npm run infra:up"',
    );
    throw err;
  }
  lifecycle.onShutdown('mongo', disconnectMongo, 50);
  if (env.NODE_ENV !== 'production') await syncAllIndexes(logger);

  const redis = getAppRedis(env.REDIS_URL, logger);
  lifecycle.onShutdown('redis', closeAllRedis, 40);
  if (!(await pingRedis(redis, 5000))) {
    logger.fatal(
      { target: redactRedisUrl(env.REDIS_URL) },
      'Redis not reachable — run "npm run infra:up"',
    );
    throw new Error('Redis not reachable');
  }
  lifecycle.onShutdown('queues', () => closeAllQueues({ logger }), 30);

  const emailProvider = options.emailProvider ?? createEmailProvider(env, logger);
  setEmail(
    createEmailService({
      provider: emailProvider,
      queue: createQueue<EmailJobData>(QUEUES.email, queueDeps),
      logger,
    }),
  );
  lifecycle.onShutdown(
    'email',
    async () => {
      await emailProvider.close();
      setEmail(undefined);
    },
    35,
  );
  if (emailProvider.driver === 'smtp') {
    // Non-blocking: a slow/broken SMTP server must not stop the API (jobs retry).
    void emailProvider.verify().then((ok) => {
      if (ok) logger.info('email: smtp ready');
      else logger.warn('email: smtp verify failed — queued emails will retry');
    });
  } else if (emailProvider.driver === 'log') {
    logger.info('email: log driver (emails are logged, not sent)');
  }

  const storage = createStorage(env, logger);
  const contactJobs = queueContactJobs(createQueue(QUEUES.contacts, queueDeps));
  const billingJobs = queueBillingJobs(createQueue(QUEUES.billing, queueDeps));
  const aiJobs = queueAiJobs(createQueue(QUEUES.ai, queueDeps));
  const aiProvider = createAiProvider(env);
  logger.info({ provider: aiProvider.name }, 'ai: provider ready');

  const callRegistry = new CallRegistry(redis);
  const voice = createVoiceProviders(env);
  logger.info({ provider: voice.name, pipeline: voice.ai.pipeline }, 'voice: providers ready');
  // dry-run calls (Phase 8): always the fake voice + fake AI (no spend), TTS without the cache
  const dryRun = createDryRunPrograms({ env, storage, redis });
  const callTts = new TtsCache({ tts: voice.tts, storage });
  // the programs of AI calls (web, phone and — Phase 12 — WhatsApp)
  const scriptFor = createScriptFactory({
    env,
    secretKey: secretBoxKey(env),
    provider: aiProvider,
    stt: voice.stt,
    storage,
    redis,
    controller: new AiVoiceController({
      voice: voice.ai,
      ai: aiProvider,
      embeddingModel: env.OPENAI_EMBEDDING_MODEL,
      secretKey: secretBoxKey(env),
      http: { policy: outgoingPolicy(env) },
    }),
  });
  const callManager = new CallManager({
    logger,
    registry: callRegistry,
    dryRun,
    tts: callTts,
    storage,
    recordingDir: env.CALL_RECORDING_TMP_DIR,
    scriptFor,
  });
  // Phase 12: call-control bus — cross-process hangups (every provider) and the
  // owner of each WhatsApp call's media; its own subscriber connection
  const callBus = new CallControlBus({
    redis,
    subscriber: createSubscriber(env.REDIS_URL, logger),
  });
  await callBus.start();
  callManager.attachBus(callBus);
  lifecycle.onShutdown('call-bus', () => callBus.stop(), 7);
  /** A new `calls` webhook event reaches the call's owner at once (else every node). */
  const callsFastPath = async (event: CallsFastPathEvent): Promise<void> => {
    const message = { type: 'calls_event', ...event } as const;
    if ((await callBus.toOwner(event.waCallId, message)) === 'no_owner') {
      await callBus.toAll(message);
    }
  };
  // Phase 9: WhatsApp (Meta webhooks now; the channel API joins in T9.6)
  const whatsappQueue = env.WHATSAPP_ENABLED ? createQueue(QUEUES.whatsapp, queueDeps) : undefined;
  const whatsapp = whatsappQueue
    ? {
        ctx: {
          env,
          meta: createMetaClient(env, { redis, logger }),
          redis,
          key: secretBoxKey(env),
          callsFastPath,
        },
        jobs: queueWhatsAppJobs(whatsappQueue),
        inboxJobs: queueInboxJobs(whatsappQueue),
        templateJobs: queueTemplateJobs(whatsappQueue),
        callingJobs: queueCallingJobs(whatsappQueue),
        connectRateLimitStore: createRedisRateLimitStore(redis, 'rl:wa-connect:'),
        inboxSendRateLimitStore: createRedisRateLimitStore(redis, 'rl:inbox-send:'),
        inboxUploadRateLimitStore: createRedisRateLimitStore(redis, 'rl:inbox-upload:'),
        templatesRateLimitStore: createRedisRateLimitStore(redis, 'rl:templates:'),
        templateSyncRateLimitStore: createRedisRateLimitStore(redis, 'rl:template-sync:'),
      }
    : undefined;
  // Phase 12: WhatsApp calling (settings, permissions, calls with media in this process)
  const calling =
    whatsapp && whatsappQueue
      ? createCallingRuntime({
          ctx: whatsapp.ctx,
          service: createWhatsAppService(whatsapp.ctx),
          inbox: {
            wa: whatsapp.ctx,
            storage,
            jobs: whatsapp.inboxJobs,
            billing: createWhatsAppBillingHook(),
            templateJobs: whatsapp.templateJobs,
          },
          bus: callBus,
          calls: {
            logger,
            registry: callRegistry,
            tts: callTts,
            storage,
            recordingDir: env.CALL_RECORDING_TMP_DIR,
            scriptFor,
          },
        })
      : null;
  if (calling?.calls) {
    const calls = calling.calls;
    callManager.setWhatsAppAttach((input, leg) => calls.attachAgent(input, leg));
    lifecycle.onShutdown('whatsapp-calls', () => calls.shutdown(), 5);
  }
  if (whatsapp) {
    logger.info({ provider: whatsapp.ctx.meta.provider }, 'whatsapp: meta provider ready');
    // fake provider: auto status webhooks through the real receiver (Phase 10)
    lifecycle.onShutdown('fake-meta-statuses', connectFakeStatusWebhooks(whatsapp), 5);
    // fake provider: hang up the fake customers' WebRTC peers, cancel pending call events (Phase 12)
    if (whatsapp.ctx.meta.provider === 'fake') {
      const fake = whatsapp.ctx.meta as FakeMetaClient;
      lifecycle.onShutdown('fake-meta-calls', () => fake.stopCalls(), 5);
    }
  }
  const app = createApp({
    env,
    logger,
    ...(whatsapp ? { whatsapp: { ...whatsapp, ...(calling ? { calling } : {}) } } : {}),
    rateLimitStore: createRedisRateLimitStore(redis),
    authRateLimitStore: createRedisRateLimitStore(redis, 'rl:auth:'),
    storage,
    contactJobs,
    billingJobs,
    payments: createPaymentProvider(env),
    topupRateLimitStore: createRedisRateLimitStore(redis, 'rl:topup:'),
    aiProvider,
    aiJobs,
    aiRateLimitStores: {
      playground: createRedisRateLimitStore(redis, 'rl:playground:'),
      knowledge: createRedisRateLimitStore(redis, 'rl:kbsrc:'),
      functionTest: createRedisRateLimitStore(redis, 'rl:fntest:'),
    },
    flowRateLimitStores: {
      simulator: createRedisRateLimitStore(redis, 'rl:flowsim:'),
      audio: createRedisRateLimitStore(redis, 'rl:flowaudio:'),
    },
    campaigns: {
      exports: queueCampaignExports(createQueue(QUEUES.campaigns, queueDeps)),
      rateLimitStore: createRedisRateLimitStore(redis, 'rl:campaign:'),
    },
    calls: {
      manager: callManager,
      registry: callRegistry,
      textInput: voice.textInput,
      voiceProvider: voice.name,
      webCallStore: createRedisRateLimitStore(redis, 'rl:callweb:'),
      calloutStore: createRedisRateLimitStore(redis, 'rl:callout:'),
    },
    readiness: {
      checks: { mongo: () => pingMongo(), redis: () => pingRedis(redis) },
      isShuttingDown: lifecycle.isShuttingDown,
    },
  });
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? env.PORT, env.HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  logger.info({ port }, `API listening on http://localhost:${port}`);

  if (env.WORKERS_ENABLED) {
    await startSystemWorker(queueDeps);
    startEmailWorker({ ...queueDeps, provider: emailProvider });
    await startMaintenanceWorker({ ...queueDeps, storage });
    startContactsWorker({ ...queueDeps, storage, jobs: contactJobs });
    await startBillingWorker({
      ...queueDeps,
      storage,
      jobs: billingJobs,
      ...(whatsapp ? { whatsapp: whatsapp.ctx } : {}),
    });
    await startAiWorker({ ...queueDeps, storage, provider: aiProvider, jobs: aiJobs });
    if (whatsapp) {
      const { worker: whatsappWorker } = await startWhatsAppWorker({
        ...queueDeps,
        ctx: whatsapp.ctx,
        storage,
        ...(calling ? { calling } : {}),
      });
      lifecycle.onShutdown('whatsapp', () => whatsappWorker.close(), 6);
    }
    if (env.CAMPAIGNS_ENABLED) {
      // Phase 8: the dispatcher dials in this process (it owns the calls)
      const dispatcher = new CampaignDispatcher({
        calls: callManager,
        rate: new DialRate(redis, prefix ? `${prefix}:` : ''),
        logger,
      });
      const unwire = wireCampaigns({
        jobs: queueCampaignJobs(createQueue(QUEUES.campaigns, queueDeps)),
        dispatcher,
        calls: callManager,
        logger,
      });
      await startCampaignsWorker({ ...queueDeps, dispatcher, storage });
      lifecycle.onShutdown(
        'campaigns',
        async () => {
          await dispatcher.stop();
          unwire();
          resetProgressThrottle();
        },
        4,
      );
    }
    logger.info('workers: started');
  }

  const realtime = await createRealtime({
    server,
    redis,
    subscriber: createSubscriber(env.REDIS_URL, logger),
    logger,
    authorizeTopic,
  });
  setRealtime(realtime);

  const media = createMediaServer({
    server,
    tickets: realtime.tickets,
    logger,
    textInput: voice.textInput,
    attach: callManager.attach,
  });
  lifecycle.onShutdown(
    'calls',
    async () => {
      await callManager.shutdown();
      await media.close();
    },
    5,
  );
  lifecycle.onShutdown(
    'ws',
    async () => {
      await realtime.close();
      setRealtime(undefined);
    },
    20,
  );
  lifecycle.onShutdown(
    'http',
    () =>
      new Promise<void>((resolve) => {
        const force = setTimeout(() => server.closeAllConnections(), FORCE_CLOSE_AFTER_MS);
        force.unref();
        server.close(() => {
          clearTimeout(force);
          resolve();
        });
        server.closeIdleConnections();
      }),
    10,
  );
  if (options.installSignalHandlers ?? true) lifecycle.installSignalHandlers();

  return { server, lifecycle, port };
};
