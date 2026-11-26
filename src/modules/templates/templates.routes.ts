import { Router, type Request, type RequestHandler } from 'express';
import type { Store } from 'express-rate-limit';
import { Types } from 'mongoose';
import multer, { memoryStorage, MulterError } from 'multer';

import { TEMPLATE_LIMITS } from '../../config/limits';
import type { StorageProvider } from '../../core/storage';
import { requireAuth } from '../../shared/auth/auth-context';
import { AppError, ValidationError } from '../../shared/errors/app-error';
import { created, ok } from '../../shared/http/envelope';
import { access } from '../../shared/middlewares/access';
import { authenticate } from '../../shared/middlewares/authenticate';
import { idempotency } from '../../shared/middlewares/idempotency';
import { createRateLimiter } from '../../shared/middlewares/rate-limit';
import {
  blockWhenImpersonating,
  requirePermission,
} from '../../shared/middlewares/require-permission';
import { handle } from '../../shared/middlewares/validate';
import type { WaActor } from '../whatsapp/channel-status';
import type { WhatsAppContext } from '../whatsapp/context';

import { loadAccountChannel } from './channel';
import type { TemplateContext } from './context';
import { uploadHeaderExample } from './example-media.service';
import type { TemplateJobs } from './jobs';
import { syncLockKey } from './sync.job';
import {
  createCallPermissionTemplate,
  createTemplate,
  deleteTemplate,
  editTemplate,
  getTemplate,
  listTemplates,
  setVariableSources,
  submitTemplate,
  syncTemplates,
} from './template.service';
import {
  CallPermissionBody,
  CreateTemplateBody,
  DeleteTemplateQuery,
  EditTemplateBody,
  ListTemplatesQuery,
  SyncTemplatesBody,
  SubmitTemplateBody,
  TemplateParams,
  VariableSourcesBody,
} from './templates.schema';

export interface TemplatesRouterDeps {
  ctx: WhatsAppContext;
  jobs: TemplateJobs;
  storage?: StorageProvider;
  /** `rl:templates:` create / edit / submit / delete per user (MemoryStore when omitted). */
  rateLimitStore?: Store;
  /** `rl:template-sync:` manual syncs per number. */
  syncRateLimitStore?: Store;
}

const actorOf = (req: Request): WaActor => {
  const auth = requireAuth(req);
  // TPL: an API key acts as itself (audit `api_key`, `createdByApiKeyId`)
  if (auth.kind === 'api_key') {
    return {
      type: 'api_key',
      id: auth.apiKeyId ? new Types.ObjectId(auth.apiKeyId) : null,
      ip: req.ip ?? null,
    };
  }
  return {
    type: 'user',
    id: new Types.ObjectId(auth.userId),
    impersonatorId: auth.impersonatorId ? new Types.ObjectId(auth.impersonatorId) : null,
    ip: req.ip ?? null,
  };
};
const accountOf = (req: Request) => new Types.ObjectId(requireAuth(req).accountId);

const MAX_EXAMPLE = Math.max(...Object.values(TEMPLATE_LIMITS.headerExampleMaxBytes));
const upload = multer({
  storage: memoryStorage(),
  limits: { fileSize: MAX_EXAMPLE, files: 1, fields: 1, parts: 2 },
}).single('file');
const uploadExample: RequestHandler = (req, res, next) => {
  upload(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('WHATSAPP_MEDIA_TOO_LARGE')
          : new ValidationError([{ path: 'file', message: 'Upload one file named "file"' }]),
      );
      return;
    }
    next(err);
  });
};

/**
 * `/api/v1/whatsapp/templates` (PHASE_11_PLAN §1m): reads need `templates.read`;
 * changes `templates.manage` (owners, admins, managers), never while impersonating;
 * suspended accounts are read only (`authenticate`). List rows carry no bodies.
 */
export const createTemplatesRouter = (deps: TemplatesRouterDeps): Router => {
  const router = Router();
  router.use(authenticate({ apiKeys: true }));
  const tx: TemplateContext = {
    wa: deps.ctx,
    jobs: deps.jobs,
    ...(deps.storage ? { storage: deps.storage } : {}),
  };
  const limit = createRateLimiter({
    windowMs: 60 * 60 * 1000,
    limit: TEMPLATE_LIMITS.createsPerHourPerUser,
    // per user, or per API key (two keys never share it)
    keyGenerator: (req) =>
      `templates:${req.auth?.apiKeyId ? `key:${req.auth.apiKeyId}` : (req.auth?.userId ?? 'anonymous')}`,
    ...(deps.rateLimitStore ? { store: deps.rateLimitStore } : {}),
  });
  const manage = [
    requirePermission('templates.manage'),
    blockWhenImpersonating(),
  ] as RequestHandler[];
  /**
   * TPL: open to API keys with `templates:write`; dashboard sessions still need
   * `templates.manage` and are refused in a view login-as.
   */
  const write = [
    access({ permission: 'templates.manage', scope: 'templates:write' }),
    blockWhenImpersonating(),
  ] as RequestHandler[];
  const once = idempotency({ required: false, scope: (req) => req.auth?.accountId });
  const isKey = (req: Request) => req.auth?.kind === 'api_key';
  const syncLimit = createRateLimiter({
    windowMs: 60 * 1000,
    limit: TEMPLATE_LIMITS.syncPerMinutePerWaba,
    keyGenerator: (req) => {
      const id = (req.body as { channelId?: unknown } | undefined)?.channelId;
      return `template-sync:${typeof id === 'string' ? id : 'none'}`;
    },
    ...(deps.syncRateLimitStore ? { store: deps.syncRateLimitStore } : {}),
  });

  router.get(
    '/templates',
    access({ permission: 'templates.read', scope: ['templates:read', 'templates:write'] }),
    ...handle({ query: ListTemplatesQuery }, async ({ query, req, res }) => {
      // API keys see approved templates only (the ones they can send); TPL: a key that
      // manages templates (`templates:write`) may filter by any status
      const writer = req.auth?.scopes?.has('templates:write') ?? false;
      const keyQuery =
        req.auth?.kind === 'api_key'
          ? writer
            ? { ...query, includeDeleted: false }
            : { ...query, status: ['APPROVED' as const], includeDeleted: false }
          : query;
      ok(res, await listTemplates(accountOf(req), keyQuery));
    }),
  );
  // static paths before `/:id`
  router.post(
    '/templates',
    ...write,
    limit,
    once,
    ...handle({ body: CreateTemplateBody }, async ({ body, req, res }) => {
      created(
        res,
        await createTemplate(tx, accountOf(req), actorOf(req), body, {
          keepDraftOnSubmitError: isKey(req),
        }),
      );
    }),
  );
  router.post(
    '/templates/sync',
    ...manage,
    syncLimit,
    ...handle({ body: SyncTemplatesBody }, async ({ body, req, res }) => {
      const channel = await loadAccountChannel(accountOf(req), body.channelId);
      // the job skips this WABA for a minute (a daily / webhook sync right after)
      await deps.ctx.redis.set(syncLockKey(channel.wabaId), 'manual', 'EX', 60);
      ok(res, await syncTemplates(tx, channel._id, 'manual', actorOf(req)));
    }),
  );
  router.post(
    '/templates/call-permission',
    ...manage,
    limit,
    ...handle({ body: CallPermissionBody }, async ({ body, req, res }) => {
      created(res, await createCallPermissionTemplate(tx, accountOf(req), actorOf(req), body));
    }),
  );
  router.get(
    '/templates/:id',
    access({ permission: 'templates.read', scope: ['templates:read', 'templates:write'] }),
    ...handle({ params: TemplateParams }, async ({ params, req, res }) => {
      ok(res, await getTemplate(accountOf(req), params.id));
    }),
  );
  router.patch(
    '/templates/:id',
    ...write,
    limit,
    ...handle(
      { params: TemplateParams, body: EditTemplateBody },
      async ({ params, body, req, res }) => {
        ok(res, await editTemplate(tx, accountOf(req), actorOf(req), params.id, body));
      },
    ),
  );
  router.post(
    '/templates/:id/submit',
    ...write,
    limit,
    once,
    ...handle(
      { params: TemplateParams, body: SubmitTemplateBody },
      async ({ params, body, req, res }) => {
        ok(res, await submitTemplate(tx, accountOf(req), actorOf(req), params.id, body.channelId));
      },
    ),
  );
  router.delete(
    '/templates/:id',
    ...write,
    ...handle(
      { params: TemplateParams, query: DeleteTemplateQuery },
      async ({ params, query, req, res }) => {
        ok(
          res,
          await deleteTemplate(
            tx,
            accountOf(req),
            actorOf(req),
            params.id,
            query.scope === 'name' ? 'all' : 'one',
          ),
        );
      },
    ),
  );
  router.patch(
    '/templates/:id/variables',
    ...write,
    ...handle(
      { params: TemplateParams, body: VariableSourcesBody },
      async ({ params, body, req, res }) => {
        ok(res, await setVariableSources(accountOf(req), actorOf(req), params.id, body.sources));
      },
    ),
  );
  router.post(
    '/templates/:id/media',
    ...write,
    uploadExample,
    ...handle(
      { params: TemplateParams, body: SubmitTemplateBody },
      async ({ params, body, req, res }) => {
        if (!req.file) {
          // another account's id answers 404 before the missing file (no record is revealed)
          await getTemplate(accountOf(req), params.id);
          throw new ValidationError([{ path: 'file', message: 'Upload one file named "file"' }]);
        }
        ok(
          res,
          await uploadHeaderExample(
            tx,
            accountOf(req),
            actorOf(req),
            params.id,
            {
              bytes: req.file.buffer,
              mimeType: req.file.mimetype,
              fileName: req.file.originalname,
            },
            body.channelId,
          ),
        );
      },
    ),
  );
  return router;
};
