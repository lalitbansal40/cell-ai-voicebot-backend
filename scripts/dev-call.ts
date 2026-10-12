/**
 * DEV ONLY — one web call end to end on the dev database / Redis (`npm run dev:call`):
 * creates a call for the first owner with money, opens `/ws/media` with a real
 * WebSocket client on an in-process server, plays a scripted host (two lines,
 * waits for a key), sends silence + key 1, hangs up and prints the call summary.
 * Refuses production.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocket } from 'ws';

import { loadEnv } from '../src/config/env';
import { getAppRedis, closeAllRedis } from '../src/core/queues/redis';
import { WsTicketService } from '../src/core/realtime/ws-tickets';
import { createStorage } from '../src/core/storage';
import { createMediaServer } from '../src/core/telephony/media-server';
import { createVoiceProviders } from '../src/core/voice/providers';
import { TtsCache } from '../src/core/voice/tts-cache';
import { CallModel } from '../src/db/models/call.model';
import { UserModel } from '../src/db/models/user.model';
import { WalletModel } from '../src/db/models/wallet.model';
import { connectMongo, disconnectMongo } from '../src/db/mongo';
import { CallManager } from '../src/modules/calls/call.service';
import { CallRegistry } from '../src/modules/calls/registry';
import type { CallIO } from '../src/modules/calls/session';
import { createLogger } from '../src/shared/logger';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('dev:call refuses to run in production');
  process.exit(1);
}

const main = async () => {
  const logger = createLogger({ ...env, LOG_LEVEL: 'warn' });
  const step = (msg: string) => console.error(`dev:call — ${msg}`);
  await connectMongo(env, logger);
  step('mongo connected');
  const redis = getAppRedis(env.REDIS_URL, logger);
  const wallet = await WalletModel.findOne({ balanceMicros: { $gt: 50_000_000 } }).lean();
  if (!wallet) throw new Error('No wallet with ₹50+ — run npm run db:seed or add money first');
  const user = await UserModel.findOne({ accountId: wallet.accountId, status: 'active' }).lean();
  if (!user) throw new Error('No active user in that account');

  const storage = createStorage(env, logger);
  const voice = createVoiceProviders(env);
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const tickets = new WsTicketService(redis);
  const manager = new CallManager({
    logger,
    registry: new CallRegistry(redis),
    tts: new TtsCache({ tts: voice.tts, storage }),
    storage,
    recordingDir: env.CALL_RECORDING_TMP_DIR,
    tickets,
    scriptFor: () =>
      Promise.resolve({
        voice: 'coral',
        language: 'hinglish',
        script: {
          run: async (io: CallIO) => {
            // listen first: a key pressed while the bot speaks still counts
            const key = new Promise<void>((resolve) => io.leg.onDtmf(() => resolve()));
            await io.say('Namaste, yeh ek test call hai.');
            await key;
            io.customerDone();
            await io.say('Dhanyavaad, namaste.');
            return 'hangup_node' as const;
          },
          stop: () => Promise.resolve(),
          result: () => ({
            outcome: {},
            disposition: null,
            variables: {},
            flowRunId: null,
            aiSeconds: 0,
            languageDetected: null,
          }),
        },
      }),
  });
  const media = createMediaServer({
    server,
    tickets,
    logger,
    textInput: voice.textInput,
    attach: manager.attach,
  });
  step('creating the call');
  const created = await manager.createWebCall({
    accountId: wallet.accountId.toString(),
    userId: user._id.toString(),
    source: { kind: 'agent' },
    contactId: null,
    variables: {},
  });
  const port = (server.address() as AddressInfo).port;
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws/media?ticket=${created.mediaTicket}`);
  let framesIn = 0;
  ws.on('message', (_data, isBinary) => {
    if (isBinary) framesIn += 1;
  });
  await new Promise<void>((r) => ws.once('open', () => r()));
  step('media socket open');
  ws.send(JSON.stringify({ type: 'call.ready', sampleRate: 24000 }));
  const silence = Buffer.alloc(960);
  const timer = setInterval(() => ws.send(silence), 20);
  await new Promise((r) => setTimeout(r, 4000));
  step('pressing 1');
  ws.send(JSON.stringify({ type: 'call.dtmf', digit: '1' }));
  await new Promise<void>((r) => ws.once('close', () => r()));
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 500));
  const call = await CallModel.findById(created.callId).lean();
  console.log(
    JSON.stringify(
      {
        callId: created.callId,
        status: call?.status,
        endReason: call?.endReason,
        durationSec: call?.durationSec,
        costMicros: call?.cost.totalMicros,
        recordingBytes: call?.recording?.sizeBytes ?? null,
        framesFromServer: framesIn,
      },
      null,
      2,
    ),
  );
  await media.close();
  server.close();
  await disconnectMongo();
  await closeAllRedis();
};

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
