import { DelayedError, type Job, type Queue, type Worker } from 'bullmq';

import { WHATSAPP_LIMITS } from '../../../config/limits';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../../db/models/whatsapp-channel.model';
import { hasDeferredInboxEvents, runInboxBackfill } from '../../../modules/inbox/backfill.job';
import { importHistoryEvent } from '../../../modules/inbox/coexistence-import';
import type { InboxContext } from '../../../modules/inbox/context';
import { createInboxHooks } from '../../../modules/inbox/hooks';
import {
  INBOX_JOBS,
  queueInboxJobs,
  type HistoryImportJobData,
  type MessageJobData,
} from '../../../modules/inbox/jobs';
import { downloadInboundMedia } from '../../../modules/inbox/media.service';
import { processReadReceipt } from '../../../modules/inbox/receipts';
import { processSend } from '../../../modules/inbox/send.job';
import {
  hasDeferredTemplateEvents,
  runTemplatesBackfill,
} from '../../../modules/templates/backfill.job';
import type { TemplateContext } from '../../../modules/templates/context';
import {
  queueTemplateJobs,
  TEMPLATE_DAILY_SYNC_CRON,
  TEMPLATE_DAILY_SYNC_JOB,
  TEMPLATE_JOBS,
  type TemplateSyncJobData,
} from '../../../modules/templates/jobs';
import { processTemplateSync, queueDailyTemplateSyncs } from '../../../modules/templates/sync.job';
import { createTemplateHooks } from '../../../modules/templates/webhooks';
import type { WhatsAppContext } from '../../../modules/whatsapp/context';
import { runHealthPass, WHATSAPP_HEALTH_CRON } from '../../../modules/whatsapp/health';
import {
  WEBHOOK_PROCESS_JOB,
  WHATSAPP_HEALTH_JOB,
  type WebhookJobData,
} from '../../../modules/whatsapp/jobs';
import type { HandlerContext } from '../../../modules/whatsapp/webhook-handlers';
import { processWebhookEvent } from '../../../modules/whatsapp/webhook-processor';
import { createWhatsAppService } from '../../../modules/whatsapp/whatsapp.service';
import type { WhatsAppService } from '../../../modules/whatsapp/whatsapp.service';
import { createWhatsAppBillingHook } from '../../../modules/whatsapp-billing/billing-hook';
import {
  hasDeferredCallEvents,
  ignoreStaleCallEvents,
} from '../../../modules/whatsapp-calling/backfill';
import {
  CALLING_DAILY_SYNC_JOB_ID,
  CALLING_JOB_OPTIONS,
  CALLING_JOBS,
  CALLING_SCHEDULES,
  CALLS_BACKFILL_IGNORE_JOB_ID,
  PERMISSION_SWEEP_JOB_ID,
  type CallingSettingsSyncJobData,
} from '../../../modules/whatsapp-calling/jobs';
import type { CallPermissionsService } from '../../../modules/whatsapp-calling/permissions.service';
import {
  createCallingRuntime,
  type CallingRuntime,
} from '../../../modules/whatsapp-calling/runtime';
import {
  createCallingSettings,
  type CallingSettingsService,
} from '../../../modules/whatsapp-calling/settings.service';
import { createCallingHooks } from '../../../modules/whatsapp-calling/webhooks';
import type { StorageProvider } from '../../storage';
import { QUEUES } from '../names';
import { createQueue, createWorker, type QueueFactoryDeps } from '../queue-factory';

/** Phase 12: the calling services the worker runs jobs with. */
export interface CallingContext {
  settings: CallingSettingsService;
  permissions: CallPermissionsService;
}

/**
 * Job processor for queue `whatsapp`: webhook events, the daily health pass and
 * (Phase 10, with an inbox context) the inbox jobs.
 */
export const processWhatsAppJob =
  (h: HandlerContext, ix?: InboxContext, tx?: TemplateContext, cx?: CallingContext) =>
  async (job: Job, token?: string): Promise<unknown> => {
    const finalAttempt = () => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (job.name === WEBHOOK_PROCESS_JOB) {
      const { eventId } = job.data as WebhookJobData;
      return { status: await processWebhookEvent(h, eventId, { finalAttempt: finalAttempt() }) };
    }
    if (job.name === WHATSAPP_HEALTH_JOB) return runHealthPass(h.service);
    // Phase 12: calls events stored before calling existed are never replayed
    if (job.name === CALLING_JOBS.backfillIgnore) {
      return { ignored: await ignoreStaleCallEvents(h.ctx) };
    }
    if (cx) {
      if (job.name === CALLING_JOBS.permissionSweep) return cx.permissions.sweep();
      if (job.name === CALLING_JOBS.settingsSync) {
        const data = job.data as Partial<CallingSettingsSyncJobData>;
        if (!data.channelId) return cx.settings.syncAll();
        const channel = await WhatsAppChannelModel.findById(
          data.channelId,
        ).lean<WhatsAppChannelDoc>();
        if (channel) await cx.settings.syncCalling(channel);
        return { synced: channel ? 1 : 0 };
      }
    }
    if (tx) {
      if (job.name === TEMPLATE_JOBS.sync) {
        return processTemplateSync(tx, job.data as TemplateSyncJobData);
      }
      if (job.name === TEMPLATE_JOBS.backfill) return runTemplatesBackfill(tx);
      if (job.name === TEMPLATE_DAILY_SYNC_JOB) return queueDailyTemplateSyncs(tx);
    }
    if (ix) {
      if (job.name === INBOX_JOBS.mediaDownload) {
        const { messageId } = job.data as MessageJobData;
        return {
          status: await downloadInboundMedia(ix, messageId, { finalAttempt: finalAttempt() }),
        };
      }
      if (job.name === INBOX_JOBS.messageSend) {
        const data = job.data as MessageJobData & { waits?: number };
        const waits = data.waits ?? 0;
        const outcome = await processSend(ix, data.messageId, {
          finalAttempt: finalAttempt(),
          waits,
        });
        if (outcome.kind === 'wait' || outcome.kind === 'later') {
          // an earlier message first / Meta asked to slow down: later, without using an attempt
          await job.updateData({ ...data, waits: waits + 1 });
          await job.moveToDelayed(Date.now() + outcome.delayMs, token);
          throw new DelayedError();
        }
        return outcome;
      }
      if (job.name === INBOX_JOBS.readReceipt) {
        const { messageId } = job.data as MessageJobData;
        return {
          status: await processReadReceipt(ix, messageId, { finalAttempt: finalAttempt() }),
        };
      }
      if (job.name === INBOX_JOBS.backfill) return runInboxBackfill(ix);
      if (job.name === INBOX_JOBS.historyImport) {
        const { eventId } = job.data as HistoryImportJobData;
        return importHistoryEvent(ix, eventId);
      }
    }
    throw new Error(`Unknown whatsapp job "${job.name}"`);
  };

/** Starts the `whatsapp` worker + the daily health scheduler (only where `WHATSAPP_ENABLED`). */
export const startWhatsAppWorker = async (
  deps: QueueFactoryDeps & {
    ctx: WhatsAppContext;
    storage?: StorageProvider;
    /** Phase 12: the process's calling runtime (the API builds it with the call bus). */
    calling?: CallingRuntime;
  },
): Promise<{ queue: Queue; worker: Worker }> => {
  const queue = createQueue(QUEUES.whatsapp, deps);
  const ix: InboxContext | undefined = deps.storage
    ? {
        wa: deps.ctx,
        storage: deps.storage,
        jobs: queueInboxJobs(queue),
        billing: createWhatsAppBillingHook(),
        templateJobs: queueTemplateJobs(queue),
      }
    : undefined;
  const tx: TemplateContext = {
    wa: deps.ctx,
    jobs: queueTemplateJobs(queue),
    ...(deps.storage ? { storage: deps.storage } : {}),
  };
  const h: HandlerContext = {
    ctx: deps.ctx,
    service: createWhatsAppService(deps.ctx),
    ...(ix ? { inbox: createInboxHooks(ix) } : {}),
    templates: createTemplateHooks(tx),
  };
  // Phase 12: calling settings + permissions (+ calls where the media runs)
  const service = h.service as WhatsAppService;
  const runtime =
    deps.calling ?? (ix ? createCallingRuntime({ ctx: deps.ctx, service, inbox: ix }) : null);
  const cx: CallingContext | undefined = runtime
    ? { settings: runtime.settings, permissions: runtime.permissions }
    : undefined;
  h.calling =
    runtime?.hooks ??
    createCallingHooks({
      settings: createCallingSettings({
        ctx: deps.ctx,
        token: (id) => service.getChannelToken(id),
      }),
    });
  const worker = createWorker(QUEUES.whatsapp, processWhatsAppJob(h, ix, tx, cx), {
    ...deps,
    concurrency: WHATSAPP_LIMITS.workerConcurrency,
  });
  await queue.upsertJobScheduler(
    WHATSAPP_HEALTH_JOB,
    { pattern: WHATSAPP_HEALTH_CRON, tz: 'UTC' },
    { name: WHATSAPP_HEALTH_JOB },
  );
  // Phase 11: one template sync per WABA every day (04:10 IST)
  await queue.upsertJobScheduler(
    TEMPLATE_DAILY_SYNC_JOB,
    { pattern: TEMPLATE_DAILY_SYNC_CRON, tz: 'UTC' },
    { name: TEMPLATE_DAILY_SYNC_JOB },
  );
  // Phase 12: permission expiry (hourly) + Meta's call settings (daily, 04:20 IST)
  for (const sched of CALLING_SCHEDULES) {
    await queue.upsertJobScheduler(
      sched.name === CALLING_JOBS.permissionSweep
        ? PERMISSION_SWEEP_JOB_ID
        : CALLING_DAILY_SYNC_JOB_ID,
      { pattern: sched.pattern, tz: 'UTC' },
      { name: sched.name, data: { reason: 'daily' } },
    );
  }
  // events stored as deferred before the inbox existed (or while it was off) → once
  if (ix && (await hasDeferredInboxEvents())) await ix.jobs.enqueueBackfill();
  // template events stored before Phase 11 → once
  if (await hasDeferredTemplateEvents()) await tx.jobs.enqueueBackfill();
  // calls events stored before Phase 12 → ignored once (same job id = one run)
  if (await hasDeferredCallEvents()) {
    await queue.add(
      CALLING_JOBS.backfillIgnore,
      {},
      { ...CALLING_JOB_OPTIONS, jobId: CALLS_BACKFILL_IGNORE_JOB_ID },
    );
  }
  return { queue, worker };
};
