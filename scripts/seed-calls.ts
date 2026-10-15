/**
 * DEV ONLY — two finished demo calls for "Demo Finance", run through the real
 * call runtime (session, flow host, live AI controller, recording, billing)
 * on a fake clock with fake voice: the published Loan recovery flow (demo
 * contact 2 says "paid" via the mock payment API) and the Recovery Bot alone
 * (demo contact 3 promises to pay tomorrow). Idempotent: each call is marked
 * with `providerCallId` `seed:*` and skipped when it exists.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import express from 'express';
import type { Redis } from 'ioredis';
import type { Types } from 'mongoose';

import type { Env } from '../src/config/env';
import { CALL_LIMITS } from '../src/config/limits';
import type { AiProvider } from '../src/core/ai';
import { outgoingPolicy } from '../src/core/ai/ip-guard';
import type { StorageProvider } from '../src/core/storage';
import { WebCallLeg } from '../src/core/telephony/webcall';
import { AiVoiceController } from '../src/core/voice/ai-session';
import { FakeClock } from '../src/core/voice/clock';
import { ChatVoiceProvider, FakeStt, FakeTts } from '../src/core/voice/providers';
import { TtsCache } from '../src/core/voice/tts-cache';
import { AiAgentModel } from '../src/db/models/ai-agent.model';
import { CallModel } from '../src/db/models/call.model';
import { ContactModel } from '../src/db/models/contact.model';
import { FlowModel } from '../src/db/models/flow.model';
import { TranscriptTurnModel } from '../src/db/models/transcript-turn.model';
import { CallManager } from '../src/modules/calls/call.service';
import { CallRegistry } from '../src/modules/calls/registry';
import { createScriptFactory } from '../src/modules/calls/scripts';
import { createMockApisRouter } from '../src/modules/mock-apis/mock.routes';
import type { Logger } from '../src/shared/logger';

import { SEED_AGENTS } from './seed-ai';
import { demoPhone } from './seed-contacts';
import { SEED_FLOW_NAMES } from './seed-flows';

export const SEED_CALL_MARKS = { loan: 'seed:loan-paid', agent: 'seed:agent-promise' } as const;

export interface CallSeedDeps {
  env: Env;
  ownerId: Types.ObjectId;
  storage: StorageProvider;
  redis: Redis;
  provider: AiProvider;
  logger: Logger;
}

/**
 * The flow's payment check calls `APP_URL/api/v1/mock/…`: serve the mock API
 * there while the seed runs (a running dev server answers instead).
 */
const withMockApi = async <T>(env: Env, work: () => Promise<T>): Promise<T> => {
  const port = Number(new URL(env.APP_URL).port || 80);
  const app = express();
  app.use('/api/v1/mock', createMockApisRouter());
  const server: Server = createServer(app);
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, () => resolve(true)); // every interface: localhost may be ::1
  });
  try {
    return await work();
  } finally {
    if (listening) await new Promise((r) => server.close(r));
  }
};

const channel = () => ({
  sendJson: () => undefined,
  sendBinary: () => undefined,
  bufferedAmount: () => 0,
  close: () => undefined,
});

export const seedCalls = async (
  accountId: Types.ObjectId,
  deps: CallSeedDeps,
): Promise<{ calls: number }> => {
  const recordingDir = mkdtempSync(path.join(tmpdir(), 'cav-seed-calls-'));
  const stt = new FakeStt();
  const tts = new FakeTts();
  const secretKey = Buffer.alloc(32); // the seeded flow has no sealed headers
  let calls = 0;

  /** One call on a fake clock: `drive` talks to the leg while time passes. */
  const run = async (
    mark: string,
    source: Parameters<CallManager['createWebCall']>[0]['source'],
    contactPhone: string,
    drive: (say: (lineSeen: string) => Promise<void>, leg: WebCallLeg) => Promise<void>,
  ) => {
    if (await CallModel.exists({ accountId, providerCallId: mark })) return;
    const contact = await ContactModel.findOne({ accountId, phoneE164: contactPhone }).lean();
    if (!contact) throw new Error(`demo contact ${contactPhone} missing — seed contacts first`);
    const clock = new FakeClock(Date.now());
    const manager = new CallManager({
      logger: deps.logger,
      registry: new CallRegistry(deps.redis, 'seedcalls:'),
      tts: new TtsCache({ tts, storage: deps.storage }),
      storage: deps.storage,
      recordingDir,
      tickets: { issue: () => Promise.resolve({ ticket: 'wst_seed', expiresAt: '' }) },
      clock,
      scriptFor: createScriptFactory({
        env: deps.env,
        secretKey,
        provider: deps.provider,
        stt,
        storage: deps.storage,
        redis: deps.redis,
        now: () => new Date(clock.now()),
        controller: new AiVoiceController({
          voice: new ChatVoiceProvider('fake', stt, tts),
          ai: deps.provider,
          embeddingModel: deps.env.OPENAI_EMBEDDING_MODEL,
          secretKey,
          http: { policy: outgoingPolicy(deps.env) },
          now: () => new Date(clock.now()),
        }),
      }),
    });
    const created = await manager.createWebCall({
      accountId: accountId.toString(),
      userId: deps.ownerId.toString(),
      source,
      contactId: contact._id.toString(),
      variables: {},
    });
    const leg = new WebCallLeg(channel(), clock);
    await manager.attach(
      { callId: created.callId, accountId: accountId.toString(), userId: deps.ownerId.toString() },
      leg,
    );
    leg.receiveControl({ type: 'call.ready', sampleRate: CALL_LIMITS.webSampleRate });
    const quiet = new Int16Array(480);
    const pump = async (done: () => Promise<boolean>, maxMs = 180_000) => {
      for (let ms = 0; ms < maxMs; ms += 200) {
        if (await done()) return;
        for (let t = 0; t < 200; t += 20) {
          leg.receiveAudio(quiet);
          await clock.tick(20);
        }
        await new Promise((r) => setTimeout(r, 2));
      }
      throw new Error(`seed call ${mark} did not progress`);
    };
    const heard = (text: string) =>
      pump(async () =>
        Boolean(
          await TranscriptTurnModel.exists({ callId: created.callId, text: { $regex: text } }),
        ),
      );
    await drive(heard, leg);
    await pump(async () => {
      const call = await CallModel.findById(created.callId).select({ status: 1 }).lean();
      return call?.status === 'completed' || call?.status === 'failed';
    });
    await CallModel.updateOne({ _id: created.callId }, { $set: { providerCallId: mark } });
    calls += 1;
  };

  try {
    await withMockApi(deps.env, async () => {
      const loan = await FlowModel.findOne({
        accountId,
        name: SEED_FLOW_NAMES.loan,
        deletedAt: null,
      }).lean();
      if (loan?.publishedVersion) {
        await run(
          SEED_CALL_MARKS.loan,
          { kind: 'flow', flowId: loan._id, flowVersionRef: loan.publishedVersion },
          demoPhone(2),
          async (heard, leg) => {
            await heard('dabaiye');
            leg.receiveControl({ type: 'call.dtmf', digit: '1' });
          },
        );
      }
      const agent = await AiAgentModel.findOne({
        accountId,
        name: SEED_AGENTS[0]?.name ?? '',
      }).lean();
      if (agent?.isActive) {
        await run(
          SEED_CALL_MARKS.agent,
          { kind: 'agent', agentId: agent._id },
          demoPhone(3),
          async (heard, leg) => {
            await heard('baat ho sakti hai');
            leg.receiveControl({ type: 'call.say_text', text: 'abhi nahi hua, kal tak de dunga' });
            await heard('promise');
          },
        );
      }
    });
  } finally {
    rmSync(recordingDir, { recursive: true, force: true });
  }
  return { calls };
};
