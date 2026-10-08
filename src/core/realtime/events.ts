import { randomUUID } from 'node:crypto';

/** Server → client envelope (docs/conventions/websocket.md §3). */
export interface WsEventEnvelope<T = unknown> {
  id: string;
  type: string;
  ts: string;
  data: T;
}

/** Event catalogue (websocket.md §5) — emitted by later phases. */
export type CallStatus =
  'queued' | 'ringing' | 'in_progress' | 'completed' | 'failed' | 'busy' | 'no_answer' | 'canceled';

export interface WsEventMap {
  'call.created': {
    callId: string;
    direction: 'outbound' | 'inbound';
    to: string;
    campaignId?: string;
  };
  'call.status': { callId: string; status: CallStatus };
  'call.transcript': {
    callId: string;
    seq: number;
    speaker: 'customer' | 'bot' | 'agent';
    text: string;
    final: boolean;
  };
  'call.dtmf': { callId: string; digit: string };
  'call.ended': { callId: string; durationSec: number; disposition?: string; costMicros: number };
  'campaign.status': { campaignId: string; status: string };
  'campaign.progress': { campaignId: string; stats: Record<string, number> };
  'wallet.updated': { balanceMicros: number; holdMicros: number; currency: string };
  'wallet.low_balance': { availableMicros: number; thresholdMicros: number };
  'import.progress': { importJobId: string; processed: number; total: number; status: string };
  'notification.created': { notificationId: string; title: string };
  'presence.changed': { userId: string; status: 'online' | 'offline' };
  'session.revoked': {
    reason: 'logout_all' | 'password_changed' | 'disabled' | 'removed' | 'session_revoked';
  };
  'account.updated': { fields: string[] };
  'account.suspended': { reason: string };
  'account.enabled': Record<string, never>;
  'user.updated': { userId: string };
  'team.changed': Record<string, never>;
}

export type WsEventType = keyof WsEventMap;

export const createEnvelope = <T>(type: string, data: T): WsEventEnvelope<T> => ({
  id: `evt_${randomUUID()}`,
  type,
  ts: new Date().toISOString(),
  data,
});
