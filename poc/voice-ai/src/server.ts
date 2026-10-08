/**
 * Browser test mode (T0.15 step 8): talk to the PoC agent with your own mic.
 *   npm run serve  →  http://localhost:5199
 * The OpenAI key stays on this server; the browser only sends/receives PCM16 24 kHz audio.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  bufferToPcm16,
  decodeMulaw,
  pcm16ToBuffer,
  resample,
  SAMPLE_RATE_PHONE,
  SAMPLE_RATE_REALTIME,
} from './audio.ts';
import { assertBudget, recordSpend, spentUsd } from './budget.ts';
import { config, POC_ROOT, requireApiKey } from './config.ts';
import { ServerEvent } from './events.ts';
import { checkPaymentStatus, type PaymentState } from './mock-tools.ts';
import { buildInstructions, DEFAULT_VARIABLES, tools, type CallVariables } from './persona.ts';
import { RealtimeSession, type AudioMode } from './realtime-client.ts';

const PUBLIC_DIR = path.join(POC_ROOT, 'public');
const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/mic-worklet.js': 'mic-worklet.js',
};
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

const http = createServer((req, res) => {
  const file = STATIC[(req.url ?? '/').split('?')[0] ?? '/'];
  if (!file) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[file.split('.').pop() ?? 'html'] ?? 'text/plain' });
  res.end(readFileSync(path.join(PUBLIC_DIR, file)));
});

const sendJson = (ws: WebSocket, msg: Record<string, unknown>) => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
};

const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', async (browser, req) => {
  const url = new URL(req.url ?? '/ws', 'http://localhost');
  const mode = (url.searchParams.get('mode') === 'g711_ulaw' ? 'g711_ulaw' : 'pcm24k') as AudioMode;
  const model = url.searchParams.get('model') || config.model;
  const voice = url.searchParams.get('voice') || 'marin';
  const payment = (url.searchParams.get('payment') || 'not_paid') as PaymentState;
  const variables: CallVariables = {
    ...DEFAULT_VARIABLES,
    ...(url.searchParams.get('name') ? { name: url.searchParams.get('name') as string } : {}),
    ...(url.searchParams.get('amount') ? { amount: url.searchParams.get('amount') as string } : {}),
    ...(url.searchParams.get('days') ? { days: url.searchParams.get('days') as string } : {}),
  };

  let session: RealtimeSession;
  try {
    assertBudget();
    session = await RealtimeSession.connect({
      model,
      voice,
      mode,
      instructions: buildInstructions(variables),
      tools,
    });
  } catch (err) {
    sendJson(browser, { type: 'error', message: (err as Error).message });
    browser.close();
    return;
  }
  sendJson(browser, { type: 'ready', mode, model, voice, spentUsd: spentUsd() });

  let lastSpeechStop: number | undefined;
  let current: { id: string; firstAudioAt: number; itemId: string } | undefined;
  const handledTools = new Set<string>();

  session.on('event', (e: Record<string, unknown> & { type: string }) => {
    switch (e.type) {
      case ServerEvent.AudioDelta: {
        const id = String(e.response_id);
        if (current?.id !== id) {
          current = { id, firstAudioAt: session.now(), itemId: String(e.item_id) };
          if (lastSpeechStop !== undefined) {
            sendJson(browser, {
              type: 'latency',
              ms: Math.round(current.firstAudioAt - lastSpeechStop),
            });
            lastSpeechStop = undefined;
          }
        }
        const bytes = Buffer.from(String(e.delta), 'base64');
        const pcm24 =
          mode === 'pcm24k'
            ? bufferToPcm16(bytes)
            : resample(decodeMulaw(bytes), SAMPLE_RATE_PHONE, SAMPLE_RATE_REALTIME);
        if (browser.readyState === browser.OPEN) browser.send(pcm16ToBuffer(pcm24));
        break;
      }
      case ServerEvent.SpeechStarted:
        sendJson(browser, { type: 'clear' });
        if (current) session.truncate(current.itemId, session.now() - current.firstAudioAt);
        break;
      case ServerEvent.SpeechStopped:
        lastSpeechStop = session.now();
        break;
      case ServerEvent.InputTranscriptCompleted:
        sendJson(browser, { type: 'customer', text: e.transcript });
        break;
      case ServerEvent.AudioTranscriptDone:
        sendJson(browser, { type: 'bot', text: e.transcript });
        break;
      case ServerEvent.ResponseDone: {
        const response = e.response as { id: string };
        const record = session.responses.get(response.id);
        if (record?.functionCalls.length && !handledTools.has(record.id)) {
          handledTools.add(record.id);
          for (const fc of record.functionCalls) {
            const result = checkPaymentStatus(variables.customerId, payment);
            sendJson(browser, { type: 'tool', name: fc.name, arguments: fc.arguments, result });
            session.sendFunctionOutput(fc.callId, result);
          }
          session.requestResponse();
        }
        sendJson(browser, { type: 'cost', usd: session.costUsd });
        break;
      }
      case ServerEvent.Error:
        sendJson(browser, { type: 'error', message: JSON.stringify(e.error) });
        break;
      default:
    }
  });

  browser.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const pcm24 = bufferToPcm16(Buffer.from(data as Buffer));
    session.appendAudio(
      mode === 'pcm24k' ? pcm24 : resample(pcm24, SAMPLE_RATE_REALTIME, SAMPLE_RATE_PHONE),
    );
  });

  browser.on('close', () => {
    recordSpend(`browser/${mode}/${model}/${voice}`, session.costUsd);
    session.close();
  });

  session.startGreeting();
});

requireApiKey();
http.listen(config.port, () => {
  console.info(
    `Voice AI PoC browser mode → http://localhost:${config.port}  (spent so far $${spentUsd().toFixed(4)} / $${config.maxUsd})`,
  );
});
