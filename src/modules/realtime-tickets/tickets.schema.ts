import { registry } from '../../shared/openapi/registry';
import { bearer, errors, ok } from '../../shared/openapi/responses';
import { z } from '../../shared/openapi/zod';

/** Only the dashboard events channel for now (`media` arrives with the web call tester, Phase 7). */
export const IssueTicketBody = z.strictObject({ channel: z.enum(['events']).default('events') });

export const WsTicketSchema = registry.register(
  'WsTicket',
  z.object({
    ticket: z.string().openapi({ example: 'wst_q8V…' }),
    expiresAt: z.string(),
  }),
);

registry.registerPath({
  method: 'post',
  path: '/api/v1/ws/tickets',
  tags: ['Realtime'],
  summary: 'Single-use 60 s ticket for wss://…/ws/events?ticket=… (30 / min per user)',
  security: bearer,
  request: { body: { content: { 'application/json': { schema: IssueTicketBody } } } },
  responses: {
    201: ok(WsTicketSchema, 'Ticket'),
    401: errors[401],
    422: errors[422],
    429: errors[429],
  },
});
