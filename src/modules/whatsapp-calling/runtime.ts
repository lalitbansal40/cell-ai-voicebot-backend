import type { Types } from 'mongoose';

import type { InboxContext } from '../inbox/context';
import type { WhatsAppContext } from '../whatsapp/context';
import type { CallingHooks } from '../whatsapp/webhook-handlers';
import type { WhatsAppService } from '../whatsapp/whatsapp.service';

import { createBulkPermissions, type BulkPermissionsService } from './bulk-permissions';
import type { CallControlBus } from './bus';
import {
  createWhatsAppCalls,
  type WhatsAppCallsDeps,
  type WhatsAppCallsService,
} from './calls.service';
import type { CallingJobs } from './jobs';
import { createCallPermissions, type CallPermissionsService } from './permissions.service';
import { createCallingSettings, type CallingSettingsService } from './settings.service';
import { createCallingHooks, createInboxCallingHook } from './webhooks';

/** Everything WhatsApp calling runs on in one process (API + worker share it). */
export interface CallingRuntime {
  settings: CallingSettingsService;
  permissions: CallPermissionsService;
  /** Phase 18B: bulk call permission requests (runs + the job). */
  bulk: BulkPermissionsService;
  /** Present where calls are placed (the media process). */
  calls: WhatsAppCallsService | null;
  /** For `HandlerContext.calling` (the WhatsApp worker). */
  hooks: CallingHooks;
}

export const createCallingRuntime = (deps: {
  ctx: WhatsAppContext;
  service: Pick<WhatsAppService, 'getChannelToken'>;
  inbox: InboxContext;
  bus?: CallControlBus;
  /** Queues the bulk permission job (the API); the worker runs it without. */
  jobs?: CallingJobs;
  /** The Phase 7 parts calls need (tts, storage, registry, scripts…); omitted = no calls here. */
  calls?: Omit<WhatsAppCallsDeps, 'ctx' | 'token' | 'bus' | 'permissions' | 'inbox'>;
}): CallingRuntime => {
  const token = (id: Types.ObjectId | string) => deps.service.getChannelToken(id);
  const settings = createCallingSettings({ ctx: deps.ctx, token });
  const permissions = createCallPermissions({ ctx: deps.ctx, token, inbox: deps.inbox });
  deps.inbox.calling = createInboxCallingHook(permissions);
  const calls =
    deps.bus && deps.calls
      ? createWhatsAppCalls({
          ...deps.calls,
          ctx: deps.ctx,
          token,
          bus: deps.bus,
          permissions,
          inbox: deps.inbox,
        })
      : null;
  const hooks = createCallingHooks({
    settings,
    ...(calls ? { calls: (channel, value, event) => calls.onWebhook(channel, value, event) } : {}),
  });
  const bulk = createBulkPermissions({ permissions, ...(deps.jobs ? { jobs: deps.jobs } : {}) });
  return { settings, permissions, bulk, calls, hooks };
};
