import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';

import { CALL_LIMITS } from '../../config/limits';
import type { Logger } from '../../shared/logger';
import { WS_CLOSE, WS_MEDIA_PATH } from '../realtime/ws-server';
import type { WsTicketService } from '../realtime/ws-tickets';
import { fromBytes } from '../voice/audio/pcm';
import { systemClock, type Clock } from '../voice/clock';

import { WebCallLeg, type ControlMessage, type MediaChannel } from './webcall';

/** Media socket close codes (websocket.md §7–8). */
export const MEDIA_CLOSE = {
  ...WS_CLOSE,
  alreadyConnected: 4011,
  callEnded: 4012,
} as const;

const ControlSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('call.ready'),
    sampleRate: z.literal(CALL_LIMITS.webSampleRate),
  }),
  z.strictObject({ type: z.literal('call.dtmf'), digit: z.string().regex(/^[0-9*#]$/) }),
  z.strictObject({ type: z.literal('call.hangup') }),
  z.strictObject({
    type: z.literal('call.transfer_result'),
    result: z.enum(['connected', 'failed', 'no_answer']),
  }),
  z.strictObject({
    type: z.literal('call.say_text'),
    text: z.string().trim().min(1).max(CALL_LIMITS.sayTextMaxChars),
  }),
  z.strictObject({ type: z.literal('call.mute'), muted: z.boolean() }),
]);

export interface MediaAttachInput {
  callId: string;
  accountId: string;
  userId: string;
}

export type AttachResult = { ok: true } | { ok: false; code: number; reason: string };

export interface MediaServerDeps {
  server: Server;
  tickets: Pick<WsTicketService, 'consume'>;
  logger: Logger;
  /** Typed customer text allowed (`VOICE_TEXT_INPUT_ENABLED`). */
  textInput: boolean;
  /** The call session takes the leg (T7.5) or refuses the socket. */
  attach: (input: MediaAttachInput, leg: WebCallLeg) => Promise<AttachResult>;
  clock?: Clock;
}

export interface MediaServer {
  connections(): number;
  close(): Promise<void>;
}

const toBuffer = (raw: RawData): Buffer =>
  Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);

/** `/ws/media`: single-use media ticket → one socket per call → a `WebCallLeg`. */
export const createMediaServer = (deps: MediaServerDeps): MediaServer => {
  const clock = deps.clock ?? systemClock;
  const log = deps.logger.child({ component: 'media' });
  const wss = new WebSocketServer({ noServer: true, maxPayload: CALL_LIMITS.controlMaxBytes });
  const live = new Map<string, WebSocket>();

  const handle = async (
    ws: WebSocket,
    ticket: string | null,
    pending: [RawData, boolean][],
    buffer: (r: RawData, b: boolean) => void,
  ) => {
    const result = await deps.tickets.consume(ticket);
    if (result.status !== 'ok' || result.payload.channel !== 'media' || !result.payload.callId) {
      ws.close(
        result.status === 'expired' ? MEDIA_CLOSE.ticketExpired : MEDIA_CLOSE.unauthorized,
        'ticket',
      );
      return;
    }
    const { callId, accountId, userId } = result.payload;
    if (live.has(callId)) {
      ws.close(MEDIA_CLOSE.alreadyConnected, 'already connected');
      return;
    }
    live.set(callId, ws);
    const channel: MediaChannel = {
      sendJson: (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      },
      sendBinary: (frame) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame, { binary: true });
      },
      bufferedAmount: () => ws.bufferedAmount,
      close: (code, reason) => ws.close(code, reason),
    };
    const leg = new WebCallLeg(channel, clock);
    let tokens: number = CALL_LIMITS.framesBurst;
    let refilledAt = clock.now();
    const allowFrame = (): boolean => {
      const now = clock.now();
      tokens = Math.min(
        CALL_LIMITS.framesBurst,
        tokens + ((now - refilledAt) / 1000) * CALL_LIMITS.framesPerSecMax,
      );
      refilledAt = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };
    const onMessage = (raw: RawData, isBinary: boolean): void => {
      if (isBinary) {
        const bytes = toBuffer(raw);
        if (bytes.length !== CALL_LIMITS.webFrameBytes || !allowFrame()) {
          ws.close(
            MEDIA_CLOSE.policy,
            bytes.length !== CALL_LIMITS.webFrameBytes ? 'bad frame' : 'too many frames',
          );
          return;
        }
        leg.receiveAudio(fromBytes(bytes));
        return;
      }
      let parsed: ControlMessage;
      try {
        const out = ControlSchema.safeParse(JSON.parse(toBuffer(raw).toString('utf8')));
        if (!out.success) throw new Error('invalid');
        parsed = out.data;
      } catch {
        channel.sendJson({ type: 'error', code: 'bad_message' });
        return;
      }
      if (parsed.type === 'call.say_text' && !deps.textInput) {
        channel.sendJson({ type: 'error', code: 'text_input_disabled' });
        return;
      }
      leg.receiveControl(parsed);
    };
    ws.on('close', () => {
      live.delete(callId);
      leg.socketClosed('customer_hangup');
    });
    ws.on('error', (err) => log.warn({ err, callId }, 'media: socket error'));
    const attached = await deps.attach({ callId, accountId, userId }, leg);
    if (!attached.ok) {
      live.delete(callId);
      ws.close(attached.code, attached.reason);
      return;
    }
    ws.off('message', buffer);
    ws.on('message', onMessage);
    channel.sendJson({
      type: 'call.config',
      textInput: deps.textInput,
      sampleRate: CALL_LIMITS.webSampleRate,
      frameBytes: CALL_LIMITS.webFrameBytes,
    });
    leg.ringing();
    for (const [raw, isBinary] of pending.splice(0)) onMessage(raw, isBinary);
    log.debug({ callId, accountId }, 'media: connected');
  };

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_MEDIA_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      const pending: [RawData, boolean][] = [];
      const buffer = (raw: RawData, isBinary: boolean): void => {
        if (pending.length < 50) pending.push([raw, isBinary]);
      };
      ws.on('message', buffer);
      void handle(ws, url.searchParams.get('ticket'), pending, buffer).catch((err: unknown) => {
        log.error({ err }, 'media: attach failed');
        ws.close(1011, 'error');
      });
    });
  };
  deps.server.on('upgrade', onUpgrade);

  return {
    connections: () => live.size,
    close: async () => {
      deps.server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.close(MEDIA_CLOSE.goingAway, 'server shutting down');
      // give the close handshakes a moment, then drop whatever is left
      for (let i = 0; i < 20 && wss.clients.size > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
};
