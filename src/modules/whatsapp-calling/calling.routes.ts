import { Router, type Request } from 'express';
import type { Store } from 'express-rate-limit';
import { Types } from 'mongoose';

import { UserModel } from '../../db/models/user.model';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError } from '../../shared/errors/app-error';
import { created, ok } from '../../shared/http/envelope';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { findCall, viewOne } from '../calls/calls.service';

import type { CallCommand } from './bus';
import {
  CallingParams,
  CallHoldBody,
  CallTransferBody,
  PermissionQuery,
  PermissionRequestBody,
  StartWhatsAppCallBody,
} from './calling-api.schema';
import { CallAvailabilityBody, CallingSettingsPatch } from './calling.schema';
import type { CallingRuntime } from './runtime';

export interface CallingRouterDeps {
  runtime: CallingRuntime;
  stores?: { calls?: Store; permissions?: Store; settings?: Store };
}

const actor = (req: Request) => {
  const auth = requireAuth(req);
  const userId = new Types.ObjectId(auth.userId);
  return {
    type: 'user' as const,
    id: userId,
    userId,
    accountId: new Types.ObjectId(auth.accountId),
    impersonatorId: auth.impersonatorId ? new Types.ObjectId(auth.impersonatorId) : null,
    ip: req.ip ?? null,
  };
};

/** Settings and permissions share the exact runtime used by webhook and media handlers. */
export const createCallingRouter = ({ runtime, stores = {} }: CallingRouterDeps): Router => {
  const router = Router();
  // mounted at /api/v1 next to other routers: authenticate only our own paths
  router.use(
    [
      '/whatsapp/channels/:id/calling',
      '/whatsapp/call-permissions',
      '/whatsapp/calls',
      '/calls/:id/media-ticket',
      '/users/me/call-availability',
    ],
    authenticate(),
  );
  const read = requirePermission('calls.read');
  const manage = [requirePermission('whatsapp.calling.manage'), blockWhenImpersonating()];
  const reply = [requirePermission('inbox.reply'), blockWhenImpersonating()];
  const limiter = (name: string, limit: number, windowMs: number, store?: Store, number = false) =>
    createRateLimiter({
      limit,
      windowMs,
      keyGenerator: (req) => `${name}:${number ? String(req.params.id) : requireAuth(req).userId}`,
      ...(store ? { store } : {}),
    });
  const settingsLimit = limiter('wa-calling-settings', 10, 60_000, stores.settings, true);
  router.get(
    '/whatsapp/channels/:id/calling',
    read,
    ...handle({ params: CallingParams }, async ({ req, res, params }) => {
      ok(res, await runtime.settings.getCalling(actor(req).accountId, params.id));
    }),
  );
  router.patch(
    '/whatsapp/channels/:id/calling',
    ...manage,
    settingsLimit,
    ...handle(
      { params: CallingParams, body: CallingSettingsPatch },
      async ({ req, res, params, body }) => {
        const who = actor(req);
        ok(res, await runtime.settings.updateCalling(who, who.accountId, params.id, body));
      },
    ),
  );
  router.post(
    '/whatsapp/channels/:id/calling/sync',
    ...manage,
    settingsLimit,
    ...handle({ params: CallingParams }, async ({ req, res, params }) => {
      ok(res, await runtime.settings.syncNow(actor(req).accountId, params.id));
    }),
  );
  router.get(
    '/whatsapp/call-permissions',
    read,
    ...handle({ query: PermissionQuery }, async ({ req, res, query }) => {
      const accountId = actor(req).accountId;
      const panel = await runtime.permissions.statusFor(
        accountId,
        query.channelId,
        query.contactId,
        { refresh: query.refresh === 'true' },
      );
      const row = await runtime.permissions.loadRow(
        accountId,
        new Types.ObjectId(query.channelId),
        new Types.ObjectId(query.contactId),
      );
      ok(res, {
        ...panel,
        history: (row?.history ?? []).map((h) => ({
          status: h.status,
          at: h.at.toISOString(),
          source: h.source,
        })),
      });
    }),
  );
  router.post(
    '/whatsapp/call-permissions/request',
    ...reply,
    limiter('wa-call-perm', 20, 3_600_000, stores.permissions),
    ...handle({ body: PermissionRequestBody }, async ({ req, res, body }) => {
      const result = await runtime.permissions.request(actor(req), body);
      created(res, { messageId: result.messageId, kind: result.kind });
    }),
  );
  router.post(
    '/whatsapp/calls',
    requirePermission('calls.trigger'),
    blockWhenImpersonating(),
    limiter('wa-call', 10, 60_000, stores.calls),
    idempotency({ scope: (req) => req.auth?.accountId }),
    ...handle({ body: StartWhatsAppCallBody }, async ({ req, res, body }) => {
      if (!runtime.calls) throw new AppError('CALL_CAPACITY');
      const who = actor(req);
      if (
        body.mode === 'ai' &&
        body.program &&
        !requireAuth(req).permissions.has(
          body.program.kind === 'flow' ? 'flows.read' : 'agents.read',
        )
      )
        throw new AppError('AUTH_FORBIDDEN');
      const result = await runtime.calls.startOutbound(who, body);
      created(res, {
        ...result,
        call: await viewOne(await findCall(who.accountId, result.callId)),
      });
    }),
  );
  const execute = async (
    req: Request,
    id: string,
    action: CallCommand['action'],
    extra: { on?: boolean; targetUserId?: string } = {},
  ) => {
    const who = actor(req);
    await findCall(who.accountId, id);
    if (!runtime.calls) throw new AppError('CALL_NOT_ACTIVE');
    return runtime.calls.command({
      callId: id,
      accountId: who.accountId.toString(),
      userId: who.userId.toString(),
      action,
      ...extra,
    });
  };
  for (const action of ['answer', 'decline'] as const) {
    router.post(
      `/whatsapp/calls/:id/${action}`,
      requirePermission('calls.answer'),
      blockWhenImpersonating(),
      ...handle({ params: CallingParams }, async ({ req, res, params }) => {
        ok(res, await execute(req, params.id, action));
      }),
    );
  }
  router.post(
    '/whatsapp/calls/:id/hold',
    requirePermission('calls.trigger'),
    blockWhenImpersonating(),
    ...handle({ params: CallingParams, body: CallHoldBody }, async ({ req, res, params, body }) => {
      ok(res, await execute(req, params.id, 'hold', body));
    }),
  );
  router.post(
    '/whatsapp/calls/:id/transfer',
    requirePermission('calls.listen'),
    blockWhenImpersonating(),
    ...handle(
      { params: CallingParams, body: CallTransferBody },
      async ({ req, res, params, body }) => {
        ok(
          res,
          await execute(
            req,
            params.id,
            'transfer',
            body.userId ? { targetUserId: body.userId } : {},
          ),
        );
      },
    ),
  );
  router.post(
    '/calls/:id/media-ticket',
    requirePermission('calls.answer'),
    blockWhenImpersonating(),
    ...handle({ params: CallingParams }, async ({ req, res, params }) => {
      ok(res, await execute(req, params.id, 'media_ticket'));
    }),
  );
  router.patch(
    '/users/me/call-availability',
    requirePermission('calls.answer'),
    blockWhenImpersonating(),
    ...handle({ body: CallAvailabilityBody }, async ({ req, res, body }) => {
      const who = actor(req);
      await UserModel.updateOne(
        { _id: who.userId, accountId: who.accountId },
        { $set: { callAvailability: body.status } },
      );
      ok(res, body);
    }),
  );
  return router;
};
