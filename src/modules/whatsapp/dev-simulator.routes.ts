import { Router } from 'express';
import { Types } from 'mongoose';

import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { ForbiddenError, NotFoundError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { handle } from '../../shared/middlewares/validate';

import type { WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import { runSimulator } from './simulator';
import { SimulatorBody } from './whatsapp.schema';

/**
 * `POST /api/v1/dev/meta/webhooks` — the dev webhook simulator (§1j). Mounted
 * only outside production with `MOCK_APIS_ENABLED`. Owners / admins
 * (`whatsapp.manage`) simulate events of their own numbers; a superadmin of any.
 */
export const createDevSimulatorRouter = (deps: {
  ctx: WhatsAppContext;
  jobs: WhatsAppJobs;
  /** Tests: sign with another secret (the receiver must refuse it). */
  secret?: string;
}): Router => {
  const router = Router();
  router.use(authenticate());
  router.post(
    '/webhooks',
    ...handle({ body: SimulatorBody }, async ({ body, req, res }) => {
      const auth = requireAuth(req);
      const channel = await WhatsAppChannelModel.findById(body.channelId)
        .select({ accountId: 1 })
        .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId }>();
      const superadmin = auth.platformRole === 'superadmin' && !auth.impersonatorId;
      if (!channel || (!superadmin && channel.accountId.toString() !== auth.accountId)) {
        throw new NotFoundError('WhatsApp number not found');
      }
      if (!superadmin && !auth.permissions.has('whatsapp.manage')) throw new ForbiddenError();
      ok(
        res,
        await runSimulator(
          deps,
          new Types.ObjectId(body.channelId),
          body.kind,
          ...(deps.secret ? [deps.secret] : []),
        ),
      );
    }),
  );
  return router;
};
