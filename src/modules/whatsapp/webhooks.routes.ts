import { Router, type Request, type Response } from 'express';

import { ok } from '../../shared/http/envelope';

import type { WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import { receiveWebhook, verifyChallenge } from './webhooks.service';

export interface MetaWebhooksDeps {
  ctx: WhatsAppContext;
  jobs: WhatsAppJobs;
}

/**
 * `/api/v1/webhooks/meta` — public. GET answers Meta's verification challenge;
 * POST is authenticated by `X-Hub-Signature-256` only. `app.ts` mounts a raw-body
 * parser (3 MB) for this path BEFORE the JSON parser. Mounted only when
 * `WHATSAPP_ENABLED` (otherwise 404).
 */
export const createMetaWebhooksRouter = ({ ctx, jobs }: MetaWebhooksDeps): Router => {
  const router = Router();
  router.get('/', (req: Request, res: Response) => {
    const challenge = verifyChallenge(ctx, req.query);
    if (challenge === null) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    res.status(200).type('text/plain').send(challenge);
  });
  router.post('/', async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    ok(res, await receiveWebhook(ctx, jobs, raw, req.get('x-hub-signature-256') ?? undefined));
  });
  return router;
};
