import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, beforeEach } from 'vitest';

import { credit } from '../../src/core/billing/engine';
import { signWebhook } from '../../src/core/meta';
import { ContactModel } from '../../src/db/models/contact.model';
import { ConversationModel } from '../../src/db/models/conversation.model';
import { InboxUploadModel } from '../../src/db/models/inbox-upload.model';
import { MessageModel, type MessageDoc } from '../../src/db/models/message.model';
import { MetaWebhookEventModel } from '../../src/db/models/meta-webhook-event.model';
import {
  WhatsAppChannelModel,
  type WhatsAppChannelDoc,
} from '../../src/db/models/whatsapp-channel.model';
import { importHistoryEvent } from '../../src/modules/inbox/coexistence-import';
import type { InboxContext } from '../../src/modules/inbox/context';
import { createInboxHooks } from '../../src/modules/inbox/hooks';
import { INBOX_JOBS, recordingInboxJobs } from '../../src/modules/inbox/jobs';
import { downloadInboundMedia } from '../../src/modules/inbox/media.service';
import { openSecret } from '../../src/modules/whatsapp/context';
import type { WhatsAppJobs } from '../../src/modules/whatsapp/jobs';
import type { HandlerContext } from '../../src/modules/whatsapp/webhook-handlers';
import { processWebhookEvent } from '../../src/modules/whatsapp/webhook-processor';
import { receiveWebhook } from '../../src/modules/whatsapp/webhooks.service';

import { createTestAccount, type TestAccount } from './auth';
import { useTempStorage } from './contacts';
import { codeFor, fakeSignup, idsFor, userActor, useWhatsAppWorld, webhookFor } from './whatsapp';

export const MEDIA_DIR = join(__dirname, '../fixtures/meta/media');
export const mediaFixture = (name: string): Buffer => readFileSync(join(MEDIA_DIR, name));

/**
 * The inbox on the fake Meta: a test account with a connected number, the inbox
 * context (temp storage, recorded jobs), and `deliver()` that signs a webhook,
 * stores it through the real receiver and processes it like the worker.
 */
export const useInboxWorld = (env: NodeJS.ProcessEnv = {}) => {
  const w = useWhatsAppWorld(env);
  const storage = useTempStorage();
  const jobs = recordingInboxJobs();
  const queued: string[] = [];
  const waJobs: WhatsAppJobs = {
    enqueueEvent: (id) => {
      queued.push(id);
      return Promise.resolve();
    },
  };
  const state = {} as {
    ix: InboxContext;
    h: HandlerContext;
    acc: TestAccount;
    channel: WhatsAppChannelDoc;
    token: string;
  };

  beforeAll(async () => {
    state.ix = { wa: w.ctx, storage, jobs };
    state.h = { ctx: w.ctx, service: w.svc, inbox: createInboxHooks(state.ix) };
    await Promise.all([
      ConversationModel.createIndexes(),
      MessageModel.createIndexes(),
      InboxUploadModel.createIndexes(),
      ContactModel.createIndexes(),
      MetaWebhookEventModel.createIndexes(),
    ]);
  });

  beforeEach(() => {
    jobs.sent.length = 0;
    queued.length = 0;
  });

  /** A fresh account + connected fake number (owner, admin, manager, agent, viewer users). */
  const setup = async (over: Parameters<typeof fakeSignup>[0] = {}) => {
    state.acc = await createTestAccount();
    // Phase 11: replies are charged (an empty wallet refuses them) — ₹1,000 test money
    await credit({
      accountId: state.acc.account._id,
      type: 'topup',
      amountMicros: 1_000 * 1_000_000,
      ref: { type: 'manual', id: 'inbox-test' },
      idempotencyKey: `inbox-test-${state.acc.account._id.toString()}`,
    });
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
      actor: userActor(),
      mode: signup.mode,
      code: codeFor(signup),
    });
    const channel = await WhatsAppChannelModel.findById(r.channel.id)
      .select('+tokenSealed')
      .lean<WhatsAppChannelDoc>();
    if (!channel) throw new Error('no channel');
    state.channel = channel;
    state.token = openSecret(w.ctx, channel.tokenSealed ?? '');
    return { channel, users, ids: idsFor(signup), signup };
  };

  /** Signs + receives a payload, then processes every queued event (like the worker). */
  const deliver = async (payload: Record<string, unknown>) => {
    const raw = Buffer.from(JSON.stringify(payload));
    await receiveWebhook(w.ctx, waJobs, raw, signWebhook(raw, w.env.FAKE_META_APP_SECRET ?? ''));
    const statuses = [];
    for (const id of queued.splice(0)) {
      statuses.push(await processWebhookEvent(state.h, id, { finalAttempt: false }));
    }
    return statuses;
  };

  /** A fixture pointed at the current channel; `edit` changes the payload first. */
  const fixture = (name: string, edit?: (p: Record<string, unknown>) => void) => {
    const p = webhookFor(name, state.channel);
    edit?.(p);
    return deliver(p);
  };

  /** Runs the recorded media downloads / history imports (send jobs come in T10.4). */
  const runJobs = async (opts: { finalAttempt?: boolean } = {}) => {
    const out: unknown[] = [];
    for (const job of jobs.sent.splice(0)) {
      if (job.name === INBOX_JOBS.mediaDownload) {
        out.push(
          await downloadInboundMedia(state.ix, job.id, { finalAttempt: opts.finalAttempt ?? true }),
        );
      } else if (job.name === INBOX_JOBS.historyImport) {
        out.push(await importHistoryEvent(state.ix, job.id));
      } else {
        jobs.sent.push(job);
      }
    }
    return out;
  };

  const messagesOf = (filter: Record<string, unknown> = {}) =>
    MessageModel.find({ accountId: state.acc.account._id, ...filter })
      .sort({ at: 1, _id: 1 })
      .lean<MessageDoc[]>();

  return {
    w,
    jobs,
    storage,
    state,
    setup,
    deliver,
    fixture,
    runJobs,
    messagesOf,
  };
};

/** Value of the first change of a webhook payload (to edit fixtures). */
export const valueOf = (p: Record<string, unknown>) =>
  (p.entry as { changes: { value: Record<string, unknown> }[] }[])[0]!.changes[0]!.value;

/** The first message of a `messages` fixture payload. */
export const firstMessage = (p: Record<string, unknown>) =>
  (valueOf(p).messages as Record<string, unknown>[])[0]!;

let wamidCounter = 0;
/** A unique wamid per call (so fixtures can be reused). */
export const uniqueWamid = (): string => {
  wamidCounter += 1;
  return `wamid.TEST${Date.now().toString(36)}${String(wamidCounter).padStart(6, '0')}`;
};

/** A customer text message payload (any customer / text / time) for the channel. */
export const customerText = (
  channel: Pick<WhatsAppChannelDoc, 'wabaId' | 'phoneNumberId' | 'displayPhoneNumber'>,
  opts: { from?: string; text?: string; name?: string | null; at?: number; id?: string } = {},
) => {
  const from = opts.from ?? '919000000101';
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: channel.wabaId,
        time: 1761120000,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: (channel.displayPhoneNumber ?? '').replace(/\D/g, ''),
                phone_number_id: channel.phoneNumberId,
              },
              contacts:
                opts.name === null
                  ? []
                  : [{ profile: { name: opts.name ?? 'Test Customer' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: opts.id ?? uniqueWamid(),
                  timestamp: String(opts.at ?? Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: opts.text ?? 'Test hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
};
