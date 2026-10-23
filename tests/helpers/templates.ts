import { beforeAll, beforeEach } from 'vitest';

import { signWebhook } from '../../src/core/meta';
import { ContactModel } from '../../src/db/models/contact.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { WhatsAppTemplateModel } from '../../src/db/models/whatsapp-template.model';
import type { TemplateContext } from '../../src/modules/templates/context';
import { recordingTemplateJobs } from '../../src/modules/templates/jobs';
import { createTemplateHooks } from '../../src/modules/templates/webhooks';
import { openSecret } from '../../src/modules/whatsapp/context';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import type { HandlerContext } from '../../src/modules/whatsapp/webhook-handlers';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../../src/modules/whatsapp/webhooks.service';

import { createTestAccount, type TestAccount } from './auth';
import { useTempStorage } from './contacts';
import { codeFor, fakeSignup, idsFor, userActor, useWhatsAppWorld } from './whatsapp';

/**
 * Templates on the fake Meta: a test account with a connected number, the template
 * context (temp storage, recorded jobs), a settable clock and `deliver()` that signs a
 * webhook, stores it through the real receiver and processes it like the worker.
 */
export const useTemplateWorld = (env: NodeJS.ProcessEnv = {}) => {
  const w = useWhatsAppWorld(env);
  const storage = useTempStorage();
  const jobs = recordingTemplateJobs();
  const queued: string[] = [];
  const waJobs: WhatsAppJobs = {
    enqueueEvent: (id) => {
      queued.push(id);
      return Promise.resolve();
    },
  };
  const clock = { now: null as Date | null };
  const state = {} as {
    tx: TemplateContext;
    h: HandlerContext;
    acc: TestAccount;
    channel: WhatsAppChannelDoc;
    token: string;
  };

  beforeAll(async () => {
    w.ctx.now = () => clock.now ?? new Date();
    state.tx = { wa: w.ctx, storage, jobs };
    state.h = { ctx: w.ctx, service: w.svc, templates: createTemplateHooks(state.tx) };
    await Promise.all([
      WhatsAppTemplateModel.createIndexes(),
      ContactModel.createIndexes(),
      MetaWebhookEventModel.createIndexes(),
    ]);
  });

  beforeEach(() => {
    jobs.syncs.length = 0;
    jobs.backfills = 0;
    queued.length = 0;
    clock.now = null;
  });

  /** A fresh account + connected fake number (owner, admin, manager, agent, viewer users). */
  const setup = async (over: Parameters<typeof fakeSignup>[0] = {}) => {
    state.acc = await createTestAccount();
    const users = {
      owner: await state.acc.addUser('owner'),
      admin: await state.acc.addUser('admin'),
      manager: await state.acc.addUser('manager'),
      agent: await state.acc.addUser('agent'),
      viewer: await state.acc.addUser('viewer'),
    };
    const signup = fakeSignup(over);
    const r = await w.svc.connect({
      accountId: state.acc.account._id,
      actor: userActor(users.owner.user._id),
      mode: signup.mode,
      code: codeFor(signup),
    });
    const channel = await WhatsAppChannelModel.findById(r.channel.id)
      .select('+tokenSealed')
      .lean<WhatsAppChannelDoc>();
    if (!channel) throw new Error('no channel');
    state.channel = channel;
    state.token = openSecret(w.ctx, channel.tokenSealed ?? '');
    return { channel, users, ids: idsFor(signup), signup, accountId: state.acc.account._id };
  };

  /** Signs + receives a payload, then processes every queued event (like the worker). */
  const deliver = async (payload: Record<string, unknown>, h: HandlerContext = state.h) => {
    const raw = Buffer.from(JSON.stringify(payload));
    await receiveWebhook(w.ctx, waJobs, raw, signWebhook(raw, w.env.FAKE_META_APP_SECRET ?? ''));
    const statuses = [];
    for (const id of queued.splice(0)) {
      statuses.push(await processWebhookEvent(h, id, { finalAttempt: false }));
    }
    return statuses;
  };

  /** A WABA-level webhook envelope for the current channel. */
  const envelope = (field: string, value: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: state.channel.wabaId, time: 1761120000, changes: [{ field, value }] }],
  });

  return { w, jobs, storage, state, clock, setup, deliver, envelope };
};
