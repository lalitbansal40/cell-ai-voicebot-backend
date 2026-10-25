import { Router } from 'express';
import { Types } from 'mongoose';

import { verifyFakeMediaSignature, type FakeMetaClient } from '../../core/meta';
import type { StorageProvider } from '../../core/storage';
import { WhatsAppChannelModel } from '../../db/models/whatsapp-channel.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { ForbiddenError, NotFoundError, ValidationError } from '../../shared/errors/app-error';
import { ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { handle } from '../../shared/middlewares/validate';
import { ObjectIdSchema } from '../../shared/validation/schemas';
import { isInboxSimulatorKind, runInboxSimulator } from '../inbox/simulator';
import { runTemplateSimulator } from '../templates/simulator';
import { isTemplateSimulatorKind, templateSimulatorPermission } from '../templates/simulator-kinds';
import type { CallingRuntime } from '../whatsapp-calling/runtime';
import { runCallingSimulator, simulateUserCall } from '../whatsapp-calling/simulator';
import {
  callingSimulatorPermission,
  isCallingSimulatorKind,
} from '../whatsapp-calling/simulator-kinds';

import type { WhatsAppContext } from './context';
import type { WhatsAppJobs } from './jobs';
import { runSimulator, type SimulatorKind } from './simulator';
import { SimulatedUserCallBody, SimulatorBody } from './whatsapp.schema';

/**
 * `/api/v1/dev/meta` — the dev webhook simulator (§1j) and the fake provider's media /
 * sends views. Mounted only outside production with `MOCK_APIS_ENABLED`. Number
 * events need `whatsapp.manage`, customer (inbox) events `inbox.reply`; a
 * superadmin may simulate for any number.
 */
export const createDevSimulatorRouter = (deps: {
  ctx: WhatsAppContext;
  jobs: WhatsAppJobs;
  storage?: StorageProvider | undefined;
  /** Phase 12: the calling runtime (permission sweep, settings sync). */
  calling?: CallingRuntime | undefined;
  /** Tests: sign with another secret (the receiver must refuse it). */
  secret?: string;
}): Router => {
  const router = Router();

  // the fake media URLs from `getMediaUrl` (signed, Bearer required like Meta's)
  router.get('/media/:id', async (req, res) => {
    const fake = deps.ctx.meta.provider === 'fake' ? (deps.ctx.meta as FakeMetaClient) : null;
    const id = req.params.id;
    const exp = Number(req.query.exp);
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
    if (!fake || !/^Bearer\s+\S+/.test(req.headers.authorization ?? '')) throw new ForbiddenError();
    if (!verifyFakeMediaSignature(fake.appSecret, id, exp, sig)) throw new ForbiddenError();
    const media = await fake.readMedia(id);
    if (!media) throw new NotFoundError('Media not found');
    res.setHeader('content-type', media.mimeType);
    res.setHeader('cache-control', 'no-store');
    res.end(media.bytes);
  });

  router.use(authenticate());
  const allowed = async (
    channelId: string,
    permission:
      | 'whatsapp.manage'
      | 'inbox.reply'
      | 'whatsapp.read'
      | 'templates.manage'
      | 'templates.read'
      | 'calls.trigger',
    auth: ReturnType<typeof requireAuth>,
  ) => {
    const channel = await WhatsAppChannelModel.findById(channelId)
      .select({ accountId: 1, phoneNumberId: 1 })
      .lean<{ _id: Types.ObjectId; accountId: Types.ObjectId; phoneNumberId: string | null }>();
    const superadmin = auth.platformRole === 'superadmin' && !auth.impersonatorId;
    if (!channel || (!superadmin && channel.accountId.toString() !== auth.accountId)) {
      throw new NotFoundError('WhatsApp number not found');
    }
    if (!superadmin && !auth.permissions.has(permission)) throw new ForbiddenError();
    return channel;
  };

  router.post(
    '/webhooks',
    ...handle({ body: SimulatorBody }, async ({ body, req, res }) => {
      const auth = requireAuth(req);
      if (isTemplateSimulatorKind(body.kind)) {
        await allowed(body.channelId, templateSimulatorPermission(body.kind), auth);
        ok(
          res,
          await runTemplateSimulator(deps, new Types.ObjectId(body.channelId), body.kind, {
            templateId: body.templateId,
            messageId: body.messageId,
            from: body.from,
          }),
        );
        return;
      }
      if (isCallingSimulatorKind(body.kind)) {
        await allowed(body.channelId, callingSimulatorPermission(body.kind), auth);
        ok(
          res,
          await runCallingSimulator(deps, new Types.ObjectId(body.channelId), body.kind, {
            from: body.from,
            waCallId: body.waCallId,
            digits: body.digits,
          }),
        );
        return;
      }
      const inbox = isInboxSimulatorKind(body.kind);
      await allowed(body.channelId, inbox ? 'inbox.reply' : 'whatsapp.manage', auth);
      const channelId = new Types.ObjectId(body.channelId);
      if (inbox) {
        ok(
          res,
          await runInboxSimulator(
            deps,
            channelId,
            body.kind as Parameters<typeof runInboxSimulator>[2],
            {
              from: body.from,
              text: body.text,
              conversationId: body.conversationId,
              days: body.days,
            },
          ),
        );
        return;
      }
      ok(
        res,
        await runSimulator(
          deps,
          channelId,
          body.kind as SimulatorKind,
          ...(deps.secret ? [deps.secret] : []),
        ),
      );
    }),
  );

  // Phase 11: the fake's templates of a number's WABA (names / statuses — no bodies)
  router.get('/templates', async (req, res) => {
    const auth = requireAuth(req);
    const parsed = ObjectIdSchema.safeParse(req.query.channelId);
    if (!parsed.success)
      throw new ValidationError([{ path: 'channelId', message: 'Must be an id' }]);
    await allowed(parsed.data, 'templates.read', auth);
    const channel = await WhatsAppChannelModel.findById(parsed.data)
      .select({ wabaId: 1 })
      .lean<{ wabaId: string }>();
    const fake = deps.ctx.meta.provider === 'fake' ? (deps.ctx.meta as FakeMetaClient) : null;
    const templates = fake && channel ? await fake.templates(channel.wabaId) : [];
    ok(
      res,
      templates.map((t) => ({
        id: t.id,
        name: t.name,
        language: t.language,
        status: t.status,
        category: t.category,
        quality: t.quality_score?.score ?? null,
      })),
    );
  });

  // what the fake recorded for a number: sends (no texts) and read receipts
  router.get('/sent', async (req, res) => {
    const auth = requireAuth(req);
    const parsed = ObjectIdSchema.safeParse(req.query.channelId);
    if (!parsed.success)
      throw new ValidationError([{ path: 'channelId', message: 'Must be an id' }]);
    const channel = await allowed(parsed.data, 'whatsapp.read', auth);
    const fake = deps.ctx.meta.provider === 'fake' ? (deps.ctx.meta as FakeMetaClient) : null;
    if (!fake || !channel.phoneNumberId) {
      ok(res, { sent: [], readReceipts: [] });
      return;
    }
    ok(res, {
      sent: await fake.sentMessages(channel.phoneNumberId),
      readReceipts: await fake.readReceipts(channel.phoneNumberId),
    });
  });

  // Phase 12: the fake customer calls the number (the inbound flow runs for real)
  router.post(
    '/calls/user-call',
    ...handle({ body: SimulatedUserCallBody }, async ({ body, req, res }) => {
      await allowed(body.channelId, 'inbox.reply', requireAuth(req));
      ok(res, await simulateUserCall(deps, body.channelId, body.from));
    }),
  );

  // Phase 12: what the fake customer's phone did on each call (no SDP, last 4 digits only)
  router.get('/calls', async (req, res) => {
    const auth = requireAuth(req);
    const parsed = ObjectIdSchema.safeParse(req.query.channelId);
    if (!parsed.success)
      throw new ValidationError([{ path: 'channelId', message: 'Must be an id' }]);
    const channel = await allowed(parsed.data, 'whatsapp.read', auth);
    const fake = deps.ctx.meta.provider === 'fake' ? (deps.ctx.meta as FakeMetaClient) : null;
    ok(res, {
      calls: fake && channel.phoneNumberId ? await fake.fakeCalls(channel.phoneNumberId) : [],
    });
  });
  return router;
};
