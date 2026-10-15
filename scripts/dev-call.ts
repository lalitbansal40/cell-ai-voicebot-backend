/**
 * DEV ONLY — one web test call end to end through the real API on the dev
 * database / Redis (`npm run dev:call`): builds the app in-process with the
 * Calls routes, the flow / agent script factory and the configured voice
 * provider (fake by default), starts `POST /api/v1/calls/web` for the first
 * published flow (or `--agent` → the first active agent), joins `/ws/media`
 * with a real WebSocket client like the browser, presses 1 at the menu (flows)
 * or types "maine payment kar diya" then "bye" (agents), and prints the summary.
 * Refuses production. Prints ids and numbers only — never texts or phones.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';

import { createApp } from '../src/app';
import { loadEnv } from '../src/config/env';
import { createAiProvider } from '../src/core/ai';
import { outgoingPolicy } from '../src/core/ai/ip-guard';
import { secretBoxKey } from '../src/core/ai/secret-box';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { WsTicketService } from '../src/core/realtime/ws-tickets';
import { createStorage } from '../src/core/storage';
import { createMediaServer } from '../src/core/telephony/media-server';
import { AiVoiceController } from '../src/core/voice/ai-session';
import { createVoiceProviders } from '../src/core/voice/providers';
import { TtsCache } from '../src/core/voice/tts-cache';
import { AiAgentModel } from '../src/db/models/ai-agent.model';
import { CallModel } from '../src/db/models/call.model';
import { FlowModel } from '../src/db/models/flow.model';
import { UserModel } from '../src/db/models/user.model';
import { WalletModel } from '../src/db/models/wallet.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { signAccessToken } from '../src/modules/auth/tokens';
import { CallManager } from '../src/modules/calls/call.service';
import { CallRegistry } from '../src/modules/calls/registry';
import { createScriptFactory } from '../src/modules/calls/scripts';
import { createLogger } from '../src/shared/logger';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('dev:call refuses to run in production');
  process.exit(1);
}
const useAgent = process.argv.includes('--agent');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const step = (msg: string) => console.error(`dev:call — ${msg}`);
  await connectMongo(env, logger);
  const redis = getAppRedis(env.REDIS_URL, logger);
  const wallet = await WalletModel.findOne({ balanceMicros: { $gt: 50_000_000 } }).lean();
  if (!wallet) throw new Error('No wallet with ₹50+ — run npm run db:seed or add money first');
  const user = await UserModel.findOne({ accountId: wallet.accountId, status: 'active' }).lean();
  if (!user) throw new Error('No active user in that account');
  const target = useAgent
    ? await AiAgentModel.findOne({ accountId: wallet.accountId, isActive: true }).lean()
    : await FlowModel.findOne({
        accountId: wallet.accountId,
        publishedVersion: { $gt: 0 },
        status: 'published',
        deletedAt: null,
      }).lean();
  if (!target)
    throw new Error(`No ${useAgent ? 'active agent' : 'published flow'} in that account`);

  const storage = createStorage(env, logger);
  const aiProvider = createAiProvider(env);
  const voice = createVoiceProviders(env);
  const tickets = new WsTicketService(redis);
  const registry = new CallRegistry(redis);
  const manager = new CallManager({
    logger,
    registry,
    tts: new TtsCache({ tts: voice.tts, storage }),
    storage,
    recordingDir: env.CALL_RECORDING_TMP_DIR,
    tickets,
    scriptFor: createScriptFactory({
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
    }),
  });
  const app = createApp({
    env,
    logger,
    storage,
    aiProvider,
    calls: { manager, registry, textInput: voice.textInput },
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const media = createMediaServer({
    server,
    tickets,
    logger,
    textInput: voice.textInput,
    attach: manager.attach,
  });
  const port = (server.address() as AddressInfo).port;
  const { token } = await signAccessToken(
    {
      sub: user._id.toString(),
      acc: user.accountId.toString(),
      rid: user.roleId.toString(),
      tv: user.tokenVersion,
      sid: `devcall_${Date.now().toString(36)}`,
    },
    '15m',
  );

  step(`POST /api/v1/calls/web (${useAgent ? 'agent' : 'published flow'})`);
  const res = await fetch(`http://127.0.0.1:${String(port)}/api/v1/calls/web`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(
      useAgent
        ? { agentId: target._id.toString(), variables: {} }
        : { flowId: target._id.toString(), testPhone: '+919000400012' },
    ),
  });
  const body = (await res.json()) as {
    data?: { call: { id: string }; mediaTicket: string; wsPath: string };
    error?: { code: string };
  };
  if (!res.ok || !body.data) throw new Error(`calls/web failed: ${body.error?.code ?? res.status}`);
  const { call, mediaTicket, wsPath } = body.data;

  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}${wsPath}?ticket=${mediaTicket}`);
  let framesIn = 0;
  let botLines = 0;
  ws.on('message', (data, isBinary) => {
    if (isBinary) framesIn += 1;
    else {
      const msg = JSON.parse((data as Buffer).toString('utf8')) as {
        type: string;
        final?: boolean;
        speaker?: string;
      };
      if (msg.type === 'call.transcript' && msg.final && msg.speaker === 'bot') botLines += 1;
    }
  });
  await new Promise<void>((r) => ws.once('open', () => r()));
  step('media socket open');
  ws.send(JSON.stringify({ type: 'call.ready', sampleRate: 24000 }));
  const silence = Buffer.alloc(960);
  const timer = setInterval(() => ws.send(silence), 20);
  const closed = new Promise<void>((r) => ws.once('close', () => r()));
  if (useAgent) {
    await sleep(8000);
    ws.send(JSON.stringify({ type: 'call.say_text', text: 'maine payment kar diya' }));
    await sleep(10_000);
    ws.send(JSON.stringify({ type: 'call.say_text', text: 'theek hai bye' }));
  } else {
    // notice + greeting + menu
    await sleep(20_000);
    step('pressing 1');
    ws.send(JSON.stringify({ type: 'call.dtmf', digit: '1' }));
  }
  await Promise.race([closed, sleep(60_000)]);
  clearInterval(timer);
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'call.hangup' }));
  await sleep(1500);
  const doc = await CallModel.findById(call.id).lean();
  console.log(
    JSON.stringify(
      {
        callId: call.id,
        status: doc?.status,
        endReason: doc?.endReason,
        disposition: doc?.disposition,
        durationSec: doc?.durationSec,
        costMicros: doc?.cost.totalMicros,
        recordingBytes: doc?.recording?.sizeBytes ?? null,
        botLines,
        framesFromServer: framesIn,
      },
      null,
      2,
    ),
  );
  await manager.shutdown();
  await media.close();
  server.closeAllConnections();
  server.close();
  await disconnectMongo();
  await closeAllRedis();
};

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
