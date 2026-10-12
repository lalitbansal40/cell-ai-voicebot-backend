import { getRealtime } from '../../core/realtime';
import { WS_MEDIA_PATH } from '../../core/realtime/ws-server';
import type { WsTicketService } from '../../core/realtime/ws-tickets';

/** Single-use 60 s ticket for the call's media socket (bound to user + account + call). */
export const issueMediaTicket = async (
  input: { userId: string; accountId: string; callId: string },
  tickets: Pick<WsTicketService, 'issue'> = getRealtime().tickets,
): Promise<{ mediaTicket: string; expiresAt: string; wsPath: string }> => {
  const { ticket, expiresAt } = await tickets.issue({ ...input, channel: 'media' });
  return { mediaTicket: ticket, expiresAt, wsPath: WS_MEDIA_PATH };
};
