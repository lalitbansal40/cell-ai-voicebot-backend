/**
 * DEV ONLY — issues a WebSocket ticket for fake ids so you can connect to /ws/events
 * before Phase 2 adds `POST /api/v1/ws/tickets`. Usage: npm run ws:dev-ticket [accountId] [userId]
 */
import { getEnv } from '../src/config/env';
import { closeAllRedis, getAppRedis } from '../src/core/queues/redis';
import { WsTicketService } from '../src/core/realtime/ws-tickets';
import { getLogger } from '../src/shared/logger';

const main = async (): Promise<void> => {
  const env = getEnv();
  if (env.NODE_ENV === 'production') throw new Error('ws:dev-ticket is disabled in production');
  const accountId = process.argv[2] ?? 'dev-account';
  const userId = process.argv[3] ?? 'dev-user';
  const tickets = new WsTicketService(getAppRedis(env.REDIS_URL, getLogger()));
  const { ticket, expiresAt } = await tickets.issue({ accountId, userId, channel: 'events' });
  console.info(`account: ${accountId}  user: ${userId}  expires: ${expiresAt} (single use)`);
  console.info(`ws://localhost:${env.PORT}/ws/events?ticket=${ticket}`);
  await closeAllRedis();
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
