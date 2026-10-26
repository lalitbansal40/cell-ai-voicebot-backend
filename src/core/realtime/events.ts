import { randomUUID } from 'node:crypto';

import type {
  TemplateCategory,
  TemplateQuality,
  TemplateStatus,
} from '../../db/models/whatsapp-template.model';

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
  'call.created': { callId: string; isTest: boolean; campaignId?: string };
  /** `provider` (Phase 12) tells WhatsApp calls apart (`whatsapp`). */
  'call.status': { callId: string; status: CallStatus; provider?: string };
  'call.transcript': {
    callId: string;
    seq: number;
    speaker: 'customer' | 'bot' | 'agent';
    text: string;
    final: boolean;
  };
  /** No digit — key presses can be PINs. */
  'call.dtmf': { callId: string };
  /** Phase 14: post-call insights changed (ids + status only — fetch the view). */
  'call.insights': { callId: string; status: string; version: number };
  'call.ended': {
    callId: string;
    /** Campaign calls only. */
    campaignId?: string;
    provider?: string;
    status: CallStatus;
    endReason: string | null;
    durationSec: number;
    disposition: string | null;
    costMicros: number;
  };
  'campaign.status': {
    campaignId: string;
    status: 'draft' | 'scheduled' | 'running' | 'paused' | 'completed' | 'canceled' | 'failed';
    pauseReason?:
      | 'manual'
      | 'wallet_empty'
      | 'budget_reached'
      | 'account_suspended'
      | 'too_many_failures'
      | 'admin'
      | 'flow_not_runnable';
    /** ISO time the calling window opens again (running, outside the window). */
    waitingUntil?: string;
  };
  'campaign.progress': { campaignId: string; stats: Record<string, number> };
  'whatsapp.channel.updated': {
    channelId: string;
    status:
      | 'connecting'
      | 'connected'
      | 'action_needed'
      | 'needs_reconnect'
      | 'restricted'
      | 'disconnected';
    qualityRating: string;
    messagingLimitTier: string | null;
    nameStatus: string | null;
  };
  /** Account level — ids and counts only, never message text. */
  'inbox.conversation.updated': {
    conversationId: string;
    status: 'open' | 'closed';
    unreadCount: number;
    assignedTo: string | null;
    lastMessageAt: string | null;
    lastMessageDirection: 'in' | 'out' | null;
  };
  'inbox.summary.updated': { unreadConversations: number };
  /** Topic `conversation:<id>` — the full message view (permission-checked subscribers only). */
  'inbox.message.created': { message: Record<string, unknown> };
  'inbox.message.updated': {
    messageId: string;
    status:
      'received' | 'queued' | 'accepted' | 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';
    error: { code: number | null; reason: string } | null;
    media: { status: 'pending' | 'ready' | 'failed' | 'expired' } | null;
    reactions: { emoji: string; by: 'customer' | 'agent' }[];
  };
  /** Topic — another agent is typing (team only). */
  'inbox.typing': { conversationId: string; userId: string; name: string };
  /** Account level (Phase 11) — status / quality / category only, never template text. */
  'whatsapp.template.updated': {
    templateId: string;
    status: TemplateStatus;
    quality: TemplateQuality | null;
    category: TemplateCategory;
  };
  /** Account level (Phase 12): the call rings for eligible users (filtered by the client). */
  'whatsapp.call.incoming': {
    callId: string;
    conversationId: string | null;
    contactId: string | null;
    channelId: string;
    ringUntil: string;
  };
  'whatsapp.call.taken': { callId: string; byUserId: string };
  'whatsapp.call.ended_ringing': { callId: string; reason: string };
  'whatsapp.call_permission.updated': {
    contactId: string;
    channelId: string;
    status: string;
    expiresAt: string | null;
  };
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
  'contacts.changed': {
    reason: 'import' | 'bulk' | 'field_deleted' | 'list_deleted' | 'dnd' | 'whatsapp_marketing';
  };
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
  'flow.updated': { flowId: string; revision: number; by: string | null };
  'flow.published': { flowId: string; version: number };
}

export type WsEventType = keyof WsEventMap;

/** Runtime list of every event — kept equal to websocket.md §5 by a test. */
export const WS_EVENT_TYPES = [
  'call.created',
  'call.status',
  'call.transcript',
  'call.dtmf',
  'call.ended',
  'call.insights',
  'campaign.status',
  'campaign.progress',
  'whatsapp.channel.updated',
  'inbox.conversation.updated',
  'inbox.summary.updated',
  'inbox.message.created',
  'inbox.message.updated',
  'inbox.typing',
  'whatsapp.template.updated',
  'whatsapp.call.incoming',
  'whatsapp.call.taken',
  'whatsapp.call.ended_ringing',
  'whatsapp.call_permission.updated',
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
  'flow.updated',
  'flow.published',
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
