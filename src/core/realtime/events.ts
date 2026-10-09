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
  'wallet.updated': {
    balanceMicros: number;
    holdMicros: number;
    availableMicros: number;
    currency: string;
    status: 'ok' | 'low' | 'exhausted';
  };
  'wallet.low_balance': { availableMicros: number; thresholdMicros: number };
  'wallet.exhausted': { availableMicros: number };
  'import.progress': { importJobId: string; processed: number; total: number; status: string };
  'export.progress': { exportJobId: string; processed: number; total: number; status: string };
  'contacts.bulk_completed': { action: string; count: number };
  'contacts.changed': { reason: 'import' | 'bulk' | 'field_deleted' | 'list_deleted' | 'dnd' };
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
  'kb.source.updated': {
    kbId: string;
    sourceId: string;
    status: 'queued' | 'processing' | 'ready' | 'failed' | 'stale';
    progress: number;
    error?: string;
  };
  'agent.updated': { agentId: string };
}

export type WsEventType = keyof WsEventMap;

/** Runtime list of every event — kept equal to websocket.md §5 by a test. */
export const WS_EVENT_TYPES = [
  'call.created',
  'call.status',
  'call.transcript',
  'call.dtmf',
  'call.ended',
  'campaign.status',
  'campaign.progress',
  'wallet.updated',
  'wallet.low_balance',
  'wallet.exhausted',
  'import.progress',
  'export.progress',
  'contacts.bulk_completed',
  'contacts.changed',
  'notification.created',
  'presence.changed',
  'session.revoked',
  'account.updated',
  'account.suspended',
  'account.enabled',
  'user.updated',
  'team.changed',
  'kb.source.updated',
  'agent.updated',
] as const satisfies readonly WsEventType[];

// Compile-time: the list above covers every key of WsEventMap.
type MissingEvent = Exclude<WsEventType, (typeof WS_EVENT_TYPES)[number]>;
export const WS_EVENT_LIST_COMPLETE: [MissingEvent] extends [never] ? true : never = true;

export const createEnvelope = <T>(type: string, data: T): WsEventEnvelope<T> => ({
  id: `evt_${randomUUID()}`,
  type,
  ts: new Date().toISOString(),
  data,
});
