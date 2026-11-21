import { Router, type Request } from 'express';
import type { Store } from 'express-rate-limit';
import { Types } from 'mongoose';

import { UserModel } from '../../db/models/user.model';
import { actingUserId, requireAuth } from '../../shared/auth/auth-context';
import { tenantFilter } from '../../shared/auth/tenant';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { accepted, created, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import { recordAudit } from '../audit/audit.service';
import { findCall, viewOne } from '../calls/calls.service';

import type { CallCommand } from './bus';
import {
  BulkPermissionBody,
  BulkRunParams,
  CallingParams,
  CallPriceQuery,
  CallHoldBody,
  CallTransferBody,
  PermissionQuery,
  PermissionRequestBody,
  StartWhatsAppCallBody,
  CallingDiagnoseBody,
} from './calling-api.schema';
import {
  CallAvailabilityBody,
  CallingSettingsPatch,
  IncomingDefaultBody,
  ScheduledCallBody,
  ScheduledCallParams,
  ScheduledCallPatch,
  ScheduledCallsQuery,
} from './calling.schema';
import { getIncomingDefault, setIncomingDefault } from './incoming-default';
import { callPricePreview } from './price.service';
import type { CallingRuntime } from './runtime';

export interface CallingRouterDeps {
  runtime: CallingRuntime;
  stores?: { calls?: Store; permissions?: Store; settings?: Store; bulk?: Store };
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
    impersonationMode: auth.impersonatorId ? (auth.impersonationMode ?? 'view') : null,
    ip: req.ip ?? null,
  };
};

/** Who starts a call: a user, or an API key acting for the user who created it (the audit names the key). */
const caller = (req: Request) => {
  const auth = requireAuth(req);
  if (auth.kind !== 'api_key') return actor(req);
  const userId = new Types.ObjectId(actingUserId(auth));
  return {
    type: 'api_key' as const,
    id: new Types.ObjectId(auth.apiKeyId),
    userId,
    accountId: new Types.ObjectId(auth.accountId),
    impersonatorId: null,
    ip: req.ip ?? null,
  };
};

/** Settings and permissions share the exact runtime used by webhook and media handlers. */
export const createCallingRouter = ({ runtime, stores = {} }: CallingRouterDeps): Router => {
  const router = Router();
  // mounted at /api/v1 next to other routers: authenticate only our own paths
  router.use(
    [
      '/whatsapp/scheduled-calls',
      '/whatsapp/incoming-default',
      '/whatsapp/channels/:id/calling',
      '/whatsapp/call-permissions',
      '/whatsapp/calls',
      '/calls/:id/media-ticket',
      '/users/me/call-availability',
    ],
    authenticate({ apiKeys: true }),
  );
  const read = requirePermission('calls.read');
  const manage = [requirePermission('whatsapp.calling.manage'), blockWhenImpersonating()];
  const reply = [requirePermission('inbox.reply'), blockWhenImpersonating()];
  const limiter = (name: string, limit: number, windowMs: number, store?: Store, number = false) =>
    createRateLimiter({
      limit,
      windowMs,
      keyGenerator: (req) => {
        const auth = requireAuth(req);
        return `${name}:${number ? String(req.params.id) : (auth.userId ?? auth.apiKeyId)}`;
      },
      ...(store ? { store } : {}),
    });
  router.get(
    '/whatsapp/channels/:id/calling/quote',
    access({ permission: 'calls.trigger', scope: 'calls:write' }),
    ...handle(
      { params: CallingParams, query: CallPriceQuery },
      async ({ req, res, params, query }) => {
        ok(res, await callPricePreview(tenantFilter(req).accountId, params.id, query.contactId));
      },
    ),
  );
  const settingsLimit = limiter('wa-calling-settings', 10, 60_000, stores.settings, true);
  router.get(
    '/whatsapp/channels/:id/calling',
    read,
    ...handle({ params: CallingParams }, async ({ req, res, params }) => {
      ok(res, await runtime.settings.getCalling(actor(req).accountId, params.id));
    }),
  );
  router.get(
    '/whatsapp/channels/:id/calling/readiness',
    requirePermission('whatsapp.read'),
    ...handle({ params: CallingParams }, async ({ req, res, params }) => {
      ok(res, await runtime.settings.readiness(actor(req).accountId, params.id));
    }),
  );
  router.post(
    '/whatsapp/channels/:id/calling/diagnose',
    requirePermission('whatsapp.manage'),
    blockWhenImpersonating(),
    ...handle(
      { params: CallingParams, body: CallingDiagnoseBody },
      async ({ req, res, params, body }) => {
        const who = actor(req);
        ok(
          res,
          await runtime.diagnose.diagnose(
            who.accountId,
            params.id,
            {
              type: 'user',
              id: who.userId,
              impersonatorId: who.impersonatorId,
            },
            body,
          ),
        );
      },
    ),
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
  // SAC-T8: scheduled AI calls ("Schedule AI call")
  const scheduledOn = (): void => {
    if (!runtime.env.WA_SCHEDULED_CALLS_ENABLED)
      throw new AppError('PROVIDER_UNAVAILABLE', 'Scheduled calls are turned off on this server.');
  };
  const scheduledLimit = limiter('wa-scheduled-calls', 30, 60_000, stores.settings);
  const scheduledActor = (req: Request) => {
    const who = caller(req);
    return {
      accountId: who.accountId,
      userId: who.userId,
      impersonatorId: who.impersonatorId ?? null,
    };
  };
  router.post(
    '/whatsapp/scheduled-calls',
    access({ permission: 'calls.trigger', scope: 'calls:write' }),
    blockWhenImpersonating(),
    scheduledLimit,
    ...handle({ body: ScheduledCallBody }, async ({ req, res, body }) => {
      scheduledOn();
      const key = req.get('Idempotency-Key')?.trim().slice(0, 100) || null;
      const out = await runtime.scheduled.create(scheduledActor(req), {
        channelId: body.channelId,
        contactId: body.contactId,
        conversationId: body.conversationId ?? null,
        program: body.program,
        purpose: body.purpose ?? null,
        dueAt: new Date(body.dueAt),
        retry: body.retry ?? null,
        origin: requireAuth(req).kind === 'api_key' ? 'api' : 'manual',
        idempotencyKey: key,
      });
      if (out.replay) ok(res, out);
      else created(res, out);
    }),
  );
  router.get(
    '/whatsapp/scheduled-calls',
    access({ permission: 'calls.read', scope: 'calls:read' }),
    ...handle({ query: ScheduledCallsQuery }, async ({ req, res, query }) => {
      const page = await runtime.scheduled.list(tenantFilter(req).accountId, {
        status: query.status,
        contactId: query.contactId,
        channelId: query.channelId,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
        cursor: query.cursor,
        limit: query.limit,
      });
      ok(res, page.items, { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null });
    }),
  );
  router.get(
    '/whatsapp/scheduled-calls/:id',
    access({ permission: 'calls.read', scope: 'calls:read' }),
    ...handle({ params: ScheduledCallParams }, async ({ req, res, params }) => {
      ok(res, await runtime.scheduled.get(tenantFilter(req).accountId, params.id));
    }),
  );
  router.patch(
    '/whatsapp/scheduled-calls/:id',
    access({ permission: 'calls.trigger', scope: 'calls:write' }),
    blockWhenImpersonating(),
    scheduledLimit,
    ...handle(
      { params: ScheduledCallParams, body: ScheduledCallPatch },
      async ({ req, res, params, body }) => {
        scheduledOn();
        ok(
          res,
          await runtime.scheduled.update(scheduledActor(req), params.id, {
            ...(body.dueAt ? { dueAt: new Date(body.dueAt) } : {}),
            ...(body.program ? { program: body.program } : {}),
            ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
            ...(body.retry ? { retry: body.retry } : {}),
          }),
        );
      },
    ),
  );
  router.post(
    '/whatsapp/scheduled-calls/:id/cancel',
    access({ permission: 'calls.trigger', scope: 'calls:write' }),
    blockWhenImpersonating(),
    ...handle({ params: ScheduledCallParams }, async ({ req, res, params }) => {
      ok(res, await runtime.scheduled.cancel(scheduledActor(req), params.id));
    }),
  );
  // SAC-T6: the account default for incoming calls ("AI se incoming calls uthao")
  router.get('/whatsapp/incoming-default', read, async (req, res) => {
    ok(res, await getIncomingDefault(actor(req).accountId));
  });
  router.put(
    '/whatsapp/incoming-default',
    ...manage,
    settingsLimit,
    ...handle({ body: IncomingDefaultBody }, async ({ req, res, body }) => {
      const who = actor(req);
      ok(
        res,
        await setIncomingDefault(runtime.env, who.accountId, body, {
          type: 'user',
          id: who.userId,
          impersonatorId: who.impersonatorId,
          ip: who.ip,
        }),
      );
    }),
  );
  // SAC-T6: end every live AI call on the number (calls with a person stay)
  router.post(
    '/whatsapp/channels/:id/calling/stop-ai-calls',
    ...manage,
    ...handle({ params: CallingParams }, async ({ req, res, params }) => {
      const who = actor(req);
      if (!runtime.calls) throw new AppError('PROVIDER_UNAVAILABLE', 'Calls do not run here.');
      const channel = await runtime.settings.getCalling(who.accountId, params.id);
      const stopped = await runtime.calls.stopAiCalls(who.accountId, new Types.ObjectId(params.id));
      await recordAudit({
        accountId: who.accountId,
        actor: { type: 'user', id: who.userId, impersonatorId: who.impersonatorId },
        action: 'whatsapp.ai_calls_stopped',
        target: { type: 'whatsapp_channel', id: params.id },
        meta: { stopped, status: channel.status },
        ip: who.ip,
      });
      ok(res, { stopped });
    }),
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
  // Phase 18B: many contacts → one run (202), progress over the socket + GET
  router.post(
    '/whatsapp/call-permissions/bulk',
    ...reply,
    requirePermission('contacts.read'),
    limiter('wa-call-perm-bulk', 5, 3_600_000, stores.bulk),
    idempotency({ scope: (req) => req.auth?.accountId }),
    ...handle({ body: BulkPermissionBody }, async ({ req, res, body }) => {
      accepted(res, await runtime.bulk.start(actor(req), body));
    }),
  );
  router.get(
    '/whatsapp/call-permissions/bulk/:runId',
    read,
    ...handle({ params: BulkRunParams }, async ({ req, res, params }) => {
      ok(res, await runtime.bulk.get(actor(req).accountId, params.runId));
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
    access({ permission: 'calls.trigger', scope: 'whatsapp-calls:write' }),
    blockWhenImpersonating(),
    limiter('wa-call', 10, 60_000, stores.calls),
    idempotency({ scope: (req) => req.auth?.accountId }),
    ...handle({ body: StartWhatsAppCallBody }, async ({ req, res, body }) => {
      if (!runtime.calls) throw new AppError('CALL_CAPACITY');
      // API keys start AI calls only (nobody is at a browser to talk)
      if (requireAuth(req).kind === 'api_key' && body.mode !== 'ai')
        throw new ValidationError([{ path: 'mode', message: 'API keys can start AI calls only' }]);
      const who = caller(req);
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
