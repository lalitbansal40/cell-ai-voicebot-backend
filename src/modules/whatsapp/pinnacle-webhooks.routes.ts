import { Router, type Request, type Response } from 'express';

import { ok } from '../../shared/http/envelope';

import type { WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import { PINNACLE_SECRET_HEADER, receivePinnacleWebhook } from './pinnacle-webhooks.service';

export interface PinnacleWebhooksDeps {
  ctx: WhatsAppContext;
  jobs: WhatsAppJobs;
}

/**
 * PN: `/api/v1/webhooks/pinnacle/:channelId` — public. `GET` answers `ok` (the partner panel
 * may ping it; nothing is read or written). `POST` is Meta's payload relayed by Pinnacle,
 * authenticated by `x-cell-webhook-secret`. `app.ts` mounts a raw-body parser (3 MB) for this
 * path before the JSON parser. Mounted only when `WHATSAPP_ENABLED` and `PINNACLE_ENABLED`.
 */
export const createPinnacleWebhooksRouter = ({ ctx, jobs }: PinnacleWebhooksDeps): Router => {
  const router = Router();
  router.get('/:channelId', (_req: Request, res: Response) => {
    res.status(200).type('text/plain').send('ok');
  });
  router.post('/:channelId', async (req: Request<{ channelId: string }>, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    ok(
      res,
      await receivePinnacleWebhook(
        ctx,
        jobs,
        req.params.channelId,
        raw,
        req.get(PINNACLE_SECRET_HEADER) ?? undefined,
      ),
    );
  });
  return router;
};
